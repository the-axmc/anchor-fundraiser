use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer, 
    Mint, 
    Token, 
    TokenAccount, 
    Transfer
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, Burn, CloseAccount, Token2022},
    token_interface,
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, 
    FundraiserError,
    SECONDS_TO_DAYS
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor
    )]
    pub contributor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: the backer's receipt mint, created by `contribute` at this
    /// address only. Token-2022 checks the rest when it is burned and closed.
    #[account(
        mut,
        seeds = [b"receipt", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub receipt_mint: UncheckedAccount<'info>,
    /// CHECK: the backer's associated token account for the receipt. Checked
    /// by hand in `burn_receipt`, so that an account the backer has closed
    /// fails with ReceiptNotHeld rather than a generic Anchor error.
    #[account(
        mut,
        seeds = [contributor.key().as_ref(), token_2022_program.key().as_ref(), receipt_mint.key().as_ref()],
        seeds::program = associated_token_program.key(),
        bump,
    )]
    pub contributor_receipt_ata: UncheckedAccount<'info>,
}

impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
 
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

        // No refund while the receipt is anywhere but the backer's own account.
        self.burn_receipt()?;

        // Transfer the funds back to the contributor
        // CPI to the token program to transfer the funds
        // As of Anchor 1.0 a CpiContext takes the program's address, not its AccountInfo.
        let cpi_program = self.token_program.key();

        // Transfer the funds from the vault to the contributor
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // Signer seeds to sign the CPI on behalf of the fundraiser account
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the contributor
        transfer(cpi_ctx, self.contributor_account.amount)?;

        // Update the fundraiser state by reducing the amount contributed
        self.fundraiser.current_amount -= self.contributor_account.amount;

        Ok(())
    }

    /// Makes sure the backer's receipt no longer exists, then closes its token
    /// account and mint, with the rent going back to the backer.
    ///
    /// The receipt can be transferred, so the backer could send it away before
    /// refunding and keep proof of backing they took back. Requiring it here
    /// turns that around: sending it away only blocks their own refund.
    fn burn_receipt(&self) -> Result<()> {
        let supply = {
            let data = self.receipt_mint.try_borrow_data()?;
            token_interface::Mint::try_deserialize(&mut &data[..])?.supply
        };

        // The address is the backer's associated token account, and Token-2022
        // gives those an immutable owner, so the mint and owner are already
        // right. What is left is whether it still exists, and what it holds.
        let held = if self.contributor_receipt_ata.owner == &token_2022::ID {
            let data = self.contributor_receipt_ata.try_borrow_data()?;
            token_interface::TokenAccount::try_deserialize(&mut &data[..])
                .ok()
                .map(|account| account.amount)
        } else {
            None
        };

        let t22 = self.token_2022_program.key();

        // A supply of 0 means whoever held the receipt has burned it already:
        // Token-2022 always lets an owner burn, and wallets offer it for
        // unknown tokens. Refusing then would lock the backer's money in the
        // vault for good, since no receipt can ever be minted again.
        if supply > 0 {
            require!(held == Some(1), FundraiserError::ReceiptNotHeld);

            // The backer signed this transaction, and owns the account.
            token_2022::burn(
                CpiContext::new(
                    t22,
                    Burn {
                        mint: self.receipt_mint.to_account_info(),
                        from: self.contributor_receipt_ata.to_account_info(),
                        authority: self.contributor.to_account_info(),
                    },
                ),
                1,
            )?;
        }

        // The backer may already have closed their empty receipt account.
        if held.is_some() {
            token_2022::close_account(CpiContext::new(
                t22,
                CloseAccount {
                    account: self.contributor_receipt_ata.to_account_info(),
                    destination: self.contributor.to_account_info(),
                    authority: self.contributor.to_account_info(),
                },
            ))?;
        }

        // The fundraiser is the mint's close authority. Token-2022 only closes
        // a mint whose supply is 0, so this also proves the receipt is gone.
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];
        token_2022::close_account(CpiContext::new_with_signer(
            t22,
            CloseAccount {
                account: self.receipt_mint.to_account_info(),
                destination: self.contributor.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            },
            &signer_seeds,
        ))?;

        Ok(())
    }
}