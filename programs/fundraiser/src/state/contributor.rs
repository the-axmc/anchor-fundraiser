use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
    // This backer's receipt serial number, from 1. 0 means no receipt yet.
    pub receipt_number: u32,
}