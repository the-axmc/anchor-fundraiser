use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
    // Receipts issued so far, which is also the last serial number handed out.
    // Only ever goes up, so a refunded backer's number is never reused.
    pub receipts_issued: u32,
}