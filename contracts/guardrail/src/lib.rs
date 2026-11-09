//! NEAR Sentinel guardrail contract (ARCHITECTURE.md §9).
//!
//! What it enforces on chain, whatever the agent's software does:
//! - only the agent account can record decisions;
//! - a TRADE decision is refused while paused, and beyond `max_trades_per_day` (UTC day of the block);
//! - the agent and the owner can pause (kill switch); only the owner can unpause or change the policy.
//!
//! Every decision hash is kept with its kind and block time and announced in a NEP-297 event, so anyone can
//! check that a published decision record existed, unchanged, before its trade (ARCHITECTURE.md §10).
//! Amount caps and allowed assets are stored for Tier 2 (#46), where the contract itself signs intents.

use std::collections::HashMap;

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

const DAY_MS: u64 = 86_400_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub owner: AccountId,
    pub agent: AccountId,
    /// 1Click / Intents asset ids the agent may trade (Tier 2).
    pub allowed_assets: Vec<String>,
    /// Per asset, smallest unit (Tier 2).
    pub max_amount_per_trade: HashMap<String, U128>,
    /// Per asset, smallest unit, per UTC day (Tier 2).
    pub max_daily_amount: HashMap<String, U128>,
    pub max_trades_per_day: u32,
    pub paused: bool,
}

/// A policy change: only the fields given are changed. `paused` is not here (pause / unpause).
#[near(serializers = [json])]
#[derive(Default)]
pub struct PolicyUpdate {
    pub agent: Option<AccountId>,
    pub allowed_assets: Option<Vec<String>>,
    pub max_amount_per_trade: Option<HashMap<String, U128>>,
    pub max_daily_amount: Option<HashMap<String, U128>>,
    pub max_trades_per_day: Option<u32>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum DecisionKind {
    Trade,
    Reject,
    Hold,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct DecisionEntry {
    pub kind: DecisionKind,
    pub recorded_at_ms: u64,
    pub seq: u64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct DecisionView {
    pub hash: String,
    pub kind: DecisionKind,
    pub recorded_at_ms: u64,
    pub seq: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayUsage {
    /// Days since the Unix epoch (UTC) of the block.
    pub day: u64,
    pub trades: u32,
    /// Tier 2: amounts spent today per asset, smallest unit.
    pub amounts: HashMap<String, U128>,
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Decisions,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guardrail {
    policy: Policy,
    decisions: LookupMap<String, DecisionEntry>,
    count: u64,
    usage: DayUsage,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "near-sentinel-guardrail", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[near]
impl Guardrail {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, max_trades_per_day: u32) -> Self {
        require!(owner != agent, "owner and agent must be different accounts");
        require!(max_trades_per_day > 0, "max_trades_per_day must be positive");
        let policy = Policy {
            owner,
            agent,
            allowed_assets: vec![],
            max_amount_per_trade: HashMap::new(),
            max_daily_amount: HashMap::new(),
            max_trades_per_day,
            paused: false,
        };
        emit("initialised", json!({ "owner": policy.owner, "agent": policy.agent, "max_trades_per_day": max_trades_per_day }));
        Self { policy, decisions: LookupMap::new(Key::Decisions), count: 0, usage: DayUsage::default() }
    }

    // ------------------------------------------------------------ agent

    /// Records a decision hash (SHA-256 of the record's bytes, 64 lowercase hex) before its trade executes.
    /// Agent only. A TRADE is refused while paused or beyond the daily trade cap. Returns the sequence number.
    pub fn record_decision(&mut self, hash: String, kind: DecisionKind) -> u64 {
        require!(env::predecessor_account_id() == self.policy.agent, "only the agent can record decisions");
        require!(valid_hash(&hash), "hash must be 64 lowercase hex characters (SHA-256)");
        require!(!self.decisions.contains_key(&hash), "decision already recorded");
        let now = env::block_timestamp_ms();
        self.roll_day(now);
        if kind == DecisionKind::Trade {
            require!(!self.policy.paused, "paused: no trade until the owner unpauses");
            require!(self.usage.trades < self.policy.max_trades_per_day, "max_trades_per_day reached for this UTC day");
            self.usage.trades += 1;
        }
        self.count += 1;
        let seq = self.count;
        self.decisions.insert(hash.clone(), DecisionEntry { kind, recorded_at_ms: now, seq });
        emit("decision_recorded", json!({ "hash": hash, "kind": kind, "seq": seq, "recorded_at_ms": now, "day_trades": self.usage.trades }));
        seq
    }

    /// Kill switch: the agent (its own risk engine) or the owner. Idempotent.
    pub fn pause(&mut self) {
        let by = env::predecessor_account_id();
        require!(by == self.policy.agent || by == self.policy.owner, "only the owner or the agent can pause");
        if !self.policy.paused {
            self.policy.paused = true;
            emit("paused", json!({ "by": by }));
        }
    }

    // ------------------------------------------------------------ owner

    pub fn unpause(&mut self) {
        self.assert_owner();
        if self.policy.paused {
            self.policy.paused = false;
            emit("unpaused", json!({ "by": self.policy.owner }));
        }
    }

    pub fn set_policy(&mut self, update: PolicyUpdate) -> Policy {
        self.assert_owner();
        let p = &mut self.policy;
        if let Some(a) = update.agent {
            require!(a != p.owner, "owner and agent must be different accounts");
            p.agent = a;
        }
        if let Some(v) = update.allowed_assets {
            p.allowed_assets = v;
        }
        if let Some(v) = update.max_amount_per_trade {
            p.max_amount_per_trade = v;
        }
        if let Some(v) = update.max_daily_amount {
            p.max_daily_amount = v;
        }
        if let Some(v) = update.max_trades_per_day {
            require!(v > 0, "max_trades_per_day must be positive");
            p.max_trades_per_day = v;
        }
        emit("policy_changed", json!({ "policy": self.policy }));
        self.policy.clone()
    }

    // ------------------------------------------------------------ views

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_decision(&self, hash: String) -> Option<DecisionView> {
        self.decisions.get(&hash).map(|e| DecisionView { hash: hash.clone(), kind: e.kind, recorded_at_ms: e.recorded_at_ms, seq: e.seq })
    }

    pub fn get_decision_count(&self) -> u64 {
        self.count
    }

    /// Today's usage (UTC day of the current block): zero when nothing was recorded today.
    pub fn get_day_usage(&self) -> DayUsage {
        let day = env::block_timestamp_ms() / DAY_MS;
        if self.usage.day == day {
            self.usage.clone()
        } else {
            DayUsage { day, ..DayUsage::default() }
        }
    }

    // ------------------------------------------------------------ internal

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.policy.owner, "only the owner can do this");
    }

    fn roll_day(&mut self, now_ms: u64) {
        let day = now_ms / DAY_MS;
        if self.usage.day != day {
            self.usage = DayUsage { day, ..DayUsage::default() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const T0: u64 = 1_794_000_000_000; // ms, some UTC day
    fn owner() -> AccountId {
        accounts(0)
    }
    fn agent() -> AccountId {
        accounts(1)
    }
    fn stranger() -> AccountId {
        accounts(2)
    }
    fn h(n: u8) -> String {
        format!("{:064x}", n)
    }
    fn as_(who: AccountId, at_ms: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(who).block_timestamp(at_ms * 1_000_000).build());
    }
    fn contract(max: u32) -> Guardrail {
        as_(owner(), T0);
        Guardrail::new(owner(), agent(), max)
    }

    #[test]
    fn initialises_with_the_policy() {
        let c = contract(3);
        let p = c.get_policy();
        assert_eq!((p.owner, p.agent, p.max_trades_per_day, p.paused), (owner(), agent(), 3, false));
        assert_eq!(c.get_decision_count(), 0);
    }

    #[test]
    #[should_panic(expected = "owner and agent must be different accounts")]
    fn owner_and_agent_differ() {
        as_(owner(), T0);
        Guardrail::new(owner(), owner(), 3);
    }

    #[test]
    fn agent_records_decisions_with_time_sequence_and_event() {
        let mut c = contract(3);
        as_(agent(), T0 + 5);
        assert_eq!(c.record_decision(h(1), DecisionKind::Hold), 1);
        assert_eq!(c.record_decision(h(2), DecisionKind::Trade), 2);
        assert_eq!(c.get_decision(h(2)), Some(DecisionView { hash: h(2), kind: DecisionKind::Trade, recorded_at_ms: T0 + 5, seq: 2 }));
        assert_eq!(c.get_decision(h(9)), None);
        assert_eq!(c.get_day_usage().trades, 1); // HOLD does not count
        let logs = get_logs();
        assert!(logs.last().unwrap().starts_with("EVENT_JSON:"), "{logs:?}");
        assert!(logs.last().unwrap().contains("\"event\":\"decision_recorded\""));
        assert!(logs.last().unwrap().contains("\"kind\":\"TRADE\""));
    }

    #[test]
    #[should_panic(expected = "only the agent can record decisions")]
    fn only_the_agent_records() {
        let mut c = contract(3);
        as_(owner(), T0);
        c.record_decision(h(1), DecisionKind::Hold);
    }

    #[test]
    #[should_panic(expected = "only the agent can record decisions")]
    fn a_stranger_cannot_record() {
        let mut c = contract(3);
        as_(stranger(), T0);
        c.record_decision(h(1), DecisionKind::Trade);
    }

    #[test]
    #[should_panic(expected = "decision already recorded")]
    fn a_hash_is_recorded_once() {
        let mut c = contract(3);
        as_(agent(), T0);
        c.record_decision(h(1), DecisionKind::Reject);
        c.record_decision(h(1), DecisionKind::Reject);
    }

    #[test]
    fn hashes_must_be_sha256_hex() {
        for bad in ["", "abc", &"A".repeat(64), &format!("{}g", "0".repeat(63)), &"0".repeat(65)] {
            let r = std::panic::catch_unwind(|| {
                let mut c = contract(3);
                as_(agent(), T0);
                c.record_decision(bad.to_string(), DecisionKind::Hold);
            });
            assert!(r.is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    #[should_panic(expected = "max_trades_per_day reached")]
    fn trade_cap_per_utc_day() {
        let mut c = contract(2);
        as_(agent(), T0);
        c.record_decision(h(1), DecisionKind::Trade);
        c.record_decision(h(2), DecisionKind::Trade);
        c.record_decision(h(3), DecisionKind::Reject); // refusals are always recordable
        c.record_decision(h(4), DecisionKind::Trade);
    }

    #[test]
    fn the_cap_resets_on_the_next_utc_day() {
        let mut c = contract(1);
        as_(agent(), T0);
        c.record_decision(h(1), DecisionKind::Trade);
        let next_day = (T0 / DAY_MS + 1) * DAY_MS;
        as_(agent(), next_day);
        assert_eq!(c.get_day_usage(), DayUsage { day: next_day / DAY_MS, trades: 0, amounts: HashMap::new() });
        c.record_decision(h(2), DecisionKind::Trade);
        assert_eq!(c.get_day_usage().trades, 1);
    }

    #[test]
    fn agent_pauses_trades_are_refused_others_still_recorded_owner_unpauses() {
        let mut c = contract(3);
        as_(agent(), T0);
        c.pause();
        assert!(c.get_policy().paused);
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"paused\"")));
        c.record_decision(h(1), DecisionKind::Reject);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c2 = contract(3);
            as_(agent(), T0);
            c2.pause();
            c2.record_decision(h(2), DecisionKind::Trade);
        }));
        assert!(refused.is_err());
        as_(owner(), T0);
        c.unpause();
        assert!(!c.get_policy().paused);
        as_(agent(), T0);
        c.record_decision(h(3), DecisionKind::Trade);
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn the_agent_cannot_unpause() {
        let mut c = contract(3);
        as_(agent(), T0);
        c.pause();
        c.unpause();
    }

    #[test]
    #[should_panic(expected = "only the owner or the agent can pause")]
    fn a_stranger_cannot_pause() {
        let mut c = contract(3);
        as_(stranger(), T0);
        c.pause();
    }

    #[test]
    fn owner_changes_the_policy_only_given_fields() {
        let mut c = contract(3);
        as_(owner(), T0);
        let p = c.set_policy(PolicyUpdate {
            max_trades_per_day: Some(5),
            allowed_assets: Some(vec!["nep141:wrap.near".into()]),
            max_amount_per_trade: Some(HashMap::from([("nep141:wrap.near".to_string(), U128(10))])),
            ..PolicyUpdate::default()
        });
        assert_eq!((p.max_trades_per_day, p.agent.clone(), p.allowed_assets.len()), (5, agent(), 1));
        assert_eq!(p.max_amount_per_trade.get("nep141:wrap.near"), Some(&U128(10)));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"policy_changed\"")));
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn the_agent_cannot_change_the_policy() {
        let mut c = contract(3);
        as_(agent(), T0);
        c.set_policy(PolicyUpdate { max_trades_per_day: Some(100), ..PolicyUpdate::default() });
    }

    #[test]
    #[should_panic(expected = "owner and agent must be different accounts")]
    fn the_owner_cannot_become_the_agent() {
        let mut c = contract(3);
        as_(owner(), T0);
        c.set_policy(PolicyUpdate { agent: Some(owner()), ..PolicyUpdate::default() });
    }

    #[test]
    fn a_new_agent_takes_over_and_the_old_one_is_locked_out() {
        let mut c = contract(3);
        as_(owner(), T0);
        c.set_policy(PolicyUpdate { agent: Some(stranger()), ..PolicyUpdate::default() });
        as_(stranger(), T0);
        c.record_decision(h(1), DecisionKind::Hold);
        let old = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            as_(agent(), T0);
            c.record_decision(h(2), DecisionKind::Hold);
        }));
        assert!(old.is_err());
    }
}
