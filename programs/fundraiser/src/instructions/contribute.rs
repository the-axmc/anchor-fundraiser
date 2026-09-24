use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Allocate, Assign, CreateAccount};
use anchor_spl::token::{
    Mint,
    transfer,
    Token,
    TokenAccount,
    Transfer
};
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token_2022::{
        self,
        spl_token_2022::{
            extension::ExtensionType,
            instruction::AuthorityType,
            state::Mint as Token2022Mint,
        },
        InitializeMint2,
        MintTo,
        SetAuthority,
        Token2022,
    },
    token_2022_extensions::{
        metadata_pointer_initialize,
        mint_close_authority_initialize,
        spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::{
            solana_borsh::v1::get_instance_packed_len,
            state::TokenMetadata,
        },
        token_metadata_initialize,
        token_metadata_update_authority,
        MetadataPointerInitialize,
        MintCloseAuthorityInitialize,
        TokenMetadataInitialize,
        TokenMetadataUpdateAuthority,
    },
};

use crate::{
    state::{
        Contributor,
        Fundraiser
    }, FundraiserError,
    ANCHOR_DISCRIMINATOR,
    MAX_CONTRIBUTION_PERCENTAGE,
    PERCENTAGE_SCALER, SECONDS_TO_DAYS,
    RECEIPT_NAME_PREFIX, RECEIPT_SYMBOL, RECEIPT_URI,
};

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Contributor::INIT_SPACE,
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
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: the backer's receipt mint. Only this program can create an
    /// account at this address, and it does so in `issue_receipt`, so the
    /// seeds are the whole check. Empty until the first contribution.
    #[account(
        mut,
        seeds = [b"receipt", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub receipt_mint: UncheckedAccount<'info>,
    /// CHECK: the backer's associated token account for the receipt. It
    /// cannot be typed, because on a first contribution neither it nor its
    /// mint exists yet when Anchor checks the accounts.
    #[account(
        mut,
        seeds = [contributor.key().as_ref(), token_2022_program.key().as_ref(), receipt_mint.key().as_ref()],
        seeds::program = associated_token_program.key(),
        bump,
    )]
    pub contributor_receipt_ata: UncheckedAccount<'info>,
}

impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64, bumps: &ContributeBumps) -> Result<()> {

        // Check that the contribution is at least one whole token.
        //
        // The previous form was `1_u8.pow(decimals)`, and 1 raised to any power is 1
        // — so the check only ever rejected a contribution of a single raw unit.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER, 
            FundraiserError::ContributionTooBig
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        // Check if the maximum contributions per contributor have been reached
        require!(
            (self.contributor_account.amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER),
            FundraiserError::MaximumContributionsReached
        );

        // Transfer the funds from the contributor to the vault.
        // As of Anchor 1.0 a CpiContext takes the program's *address*, not its
        // AccountInfo.
        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);

        // Transfer the funds from the contributor to the vault
        transfer(cpi_ctx, amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount += amount;

        self.contributor_account.amount += amount;

        // The receipt mint only exists once this backer has a receipt, so an
        // empty account is what marks a first contribution.
        if self.receipt_mint.data_is_empty() {
            self.issue_receipt(bumps)?;
        }

        Ok(())
    }

    /// Creates this backer's receipt: a Token-2022 mint with a supply of
    /// exactly one, held in their associated token account, that nobody can
    /// mint more of, freeze or rename.
    ///
    /// This is done by hand rather than with `init_if_needed`. Once the mint
    /// authority is None, `init_if_needed` would re-check it on every later
    /// contribution, find it missing, and fail with ConstraintMintMintAuthority.
    fn issue_receipt(&mut self, bumps: &ContributeBumps) -> Result<()> {
        let number = self
            .fundraiser
            .receipts_issued
            .checked_add(1)
            .ok_or(FundraiserError::MathOverflow)?;

        let fundraiser_key = self.fundraiser.key();
        let contributor_key = self.contributor.key();
        let receipt_key = self.receipt_mint.key();
        let t22 = self.token_2022_program.key();

        // The receipt mint signs for its own creation; the fundraiser signs as
        // its mint authority and its metadata's update authority.
        let receipt_bump = [bumps.receipt_mint];
        let receipt_seeds: &[&[u8]] = &[
            b"receipt",
            fundraiser_key.as_ref(),
            contributor_key.as_ref(),
            &receipt_bump,
        ];
        let maker = self.fundraiser.maker;
        let fundraiser_bump = [self.fundraiser.bump];
        let fundraiser_seeds: &[&[u8]] = &[b"fundraiser", maker.as_ref(), &fundraiser_bump];

        // The account is created at the size of the mint and its two fixed
        // extensions. Token-2022 grows it itself when the metadata is written,
        // but the lamports for that have to be there already, so the rent
        // covers both.
        let metadata = TokenMetadata {
            update_authority: OptionalNonZeroPubkey::try_from(Some(fundraiser_key))?,
            mint: receipt_key,
            name: format!("{RECEIPT_NAME_PREFIX}{number}"),
            symbol: RECEIPT_SYMBOL.to_string(),
            uri: RECEIPT_URI.to_string(),
            additional_metadata: vec![],
        };
        let space = ExtensionType::try_calculate_account_len::<Token2022Mint>(&[
            ExtensionType::MintCloseAuthority,
            ExtensionType::MetadataPointer,
        ])?;
        // Token-2022 stores an extension behind a 2 byte type and a 2 byte
        // length. `TokenMetadata::tlv_size_of` assumes the generic 12 byte
        // header instead, and would over-fund every receipt by 8 bytes of rent.
        let metadata_len = 4 + get_instance_packed_len(&metadata)?;
        let lamports = Rent::get()?.minimum_balance(space + metadata_len);

        // Anyone can send lamports to an address before it is created, and
        // create_account refuses an address that already holds any. Left
        // unhandled, a transfer of one lamport would lock this backer out of
        // the campaign. So, like Anchor's own `init`: top up, allocate, assign.
        let current = self.receipt_mint.lamports();
        if current == 0 {
            system_program::create_account(
                CpiContext::new_with_signer(
                    self.system_program.key(),
                    CreateAccount {
                        from: self.contributor.to_account_info(),
                        to: self.receipt_mint.to_account_info(),
                    },
                    &[receipt_seeds],
                ),
                lamports,
                space as u64,
                &t22,
            )?;
        } else {
            let top_up = lamports.saturating_sub(current);
            if top_up > 0 {
                system_program::transfer(
                    CpiContext::new(
                        self.system_program.key(),
                        system_program::Transfer {
                            from: self.contributor.to_account_info(),
                            to: self.receipt_mint.to_account_info(),
                        },
                    ),
                    top_up,
                )?;
            }
            system_program::allocate(
                CpiContext::new_with_signer(
                    self.system_program.key(),
                    Allocate { account_to_allocate: self.receipt_mint.to_account_info() },
                    &[receipt_seeds],
                ),
                space as u64,
            )?;
            system_program::assign(
                CpiContext::new_with_signer(
                    self.system_program.key(),
                    Assign { account_to_assign: self.receipt_mint.to_account_info() },
                    &[receipt_seeds],
                ),
                &t22,
            )?;
        }

        // Extensions go in before the mint is initialized. The close authority
        // lets `refund` close the mint once its one token is burned. The
        // metadata pointer points at the mint itself, and has no authority, so
        // it can never be pointed elsewhere.
        mint_close_authority_initialize(
            CpiContext::new(
                t22,
                MintCloseAuthorityInitialize {
                    token_program_id: self.token_2022_program.to_account_info(),
                    mint: self.receipt_mint.to_account_info(),
                },
            ),
            Some(&fundraiser_key),
        )?;
        metadata_pointer_initialize(
            CpiContext::new(
                t22,
                MetadataPointerInitialize {
                    token_program_id: self.token_2022_program.to_account_info(),
                    mint: self.receipt_mint.to_account_info(),
                },
            ),
            None,
            Some(receipt_key),
        )?;

        // 0 decimals, and no freeze authority: a frozen account cannot be
        // burned from, so a freeze authority could block a backer's refund.
        token_2022::initialize_mint2(
            CpiContext::new(
                t22,
                InitializeMint2 { mint: self.receipt_mint.to_account_info() },
            ),
            0,
            &fundraiser_key,
            None,
        )?;

        // Token-2022 refuses a metadata update authority of None at
        // initialization, so the fundraiser takes it and gives it up at once.
        token_metadata_initialize(
            CpiContext::new_with_signer(
                t22,
                TokenMetadataInitialize {
                    program_id: self.token_2022_program.to_account_info(),
                    metadata: self.receipt_mint.to_account_info(),
                    update_authority: self.fundraiser.to_account_info(),
                    mint_authority: self.fundraiser.to_account_info(),
                    mint: self.receipt_mint.to_account_info(),
                },
                &[fundraiser_seeds],
            ),
            metadata.name,
            metadata.symbol,
            metadata.uri,
        )?;
        token_metadata_update_authority(
            CpiContext::new_with_signer(
                t22,
                TokenMetadataUpdateAuthority {
                    program_id: self.token_2022_program.to_account_info(),
                    metadata: self.receipt_mint.to_account_info(),
                    current_authority: self.fundraiser.to_account_info(),
                    // Not part of the instruction; the new authority is the
                    // argument below.
                    new_authority: self.fundraiser.to_account_info(),
                },
                &[fundraiser_seeds],
            ),
            OptionalNonZeroPubkey::default(),
        )?;

        // The backer's token account for it. The associated token program
        // derives the address itself and refuses a mismatch.
        associated_token::create(CpiContext::new(
            self.associated_token_program.key(),
            associated_token::Create {
                payer: self.contributor.to_account_info(),
                associated_token: self.contributor_receipt_ata.to_account_info(),
                authority: self.contributor.to_account_info(),
                mint: self.receipt_mint.to_account_info(),
                system_program: self.system_program.to_account_info(),
                token_program: self.token_2022_program.to_account_info(),
            },
        ))?;

        // Exactly one, then no mint authority, so no second copy can exist.
        token_2022::mint_to(
            CpiContext::new_with_signer(
                t22,
                MintTo {
                    mint: self.receipt_mint.to_account_info(),
                    to: self.contributor_receipt_ata.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                &[fundraiser_seeds],
            ),
            1,
        )?;
        token_2022::set_authority(
            CpiContext::new_with_signer(
                t22,
                SetAuthority {
                    current_authority: self.fundraiser.to_account_info(),
                    account_or_mint: self.receipt_mint.to_account_info(),
                },
                &[fundraiser_seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        self.fundraiser.receipts_issued = number;
        self.contributor_account.receipt_number = number;

        Ok(())
    }
}