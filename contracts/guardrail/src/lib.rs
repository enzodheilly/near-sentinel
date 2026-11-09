//! NEAR Sentinel guardrail contract (ARCHITECTURE.md §9).
//!
//! Scaffold: the policy and who owns it. Decision log, pause and policy changes land in #43.

use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// What the agent is allowed to do. Amounts are in each asset's smallest unit (no price oracle on chain).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub owner: AccountId,
    pub agent: AccountId,
    pub max_trades_per_day: u32,
    pub paused: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guardrail {
    policy: Policy,
}

#[near]
impl Guardrail {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, max_trades_per_day: u32) -> Self {
        require!(owner != agent, "owner and agent must be different accounts");
        require!(max_trades_per_day > 0, "max_trades_per_day must be positive");
        env::log_str(&format!("guardrail initialised: owner {owner}, agent {agent}"));
        Self { policy: Policy { owner, agent, max_trades_per_day, paused: false } }
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    #[test]
    fn initialises_with_the_policy() {
        testing_env!(VMContextBuilder::new().build());
        let c = Guardrail::new(accounts(0), accounts(1), 3);
        assert_eq!(c.get_policy(), Policy { owner: accounts(0), agent: accounts(1), max_trades_per_day: 3, paused: false });
    }

    #[test]
    #[should_panic(expected = "owner and agent must be different accounts")]
    fn owner_and_agent_differ() {
        testing_env!(VMContextBuilder::new().build());
        Guardrail::new(accounts(0), accounts(0), 3);
    }
}
