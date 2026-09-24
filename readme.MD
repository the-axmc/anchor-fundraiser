# Token Fundraiser

## Prerequisites

| Tool | Version |
| --- | --- |
| Anchor | 1.1.2 (`avm install 1.1.2 && avm use 1.1.2`) |
| Solana CLI | 3.1 or newer |
| Node | 20 or newer, with `yarn` |

```bash
yarn install
anchor build
anchor keys sync   # first time only — see below
anchor test
```

The repo declares a program id it does not ship the keypair for, so your first
`anchor build` generates a different one and `anchor test` fails with
`DeclaredProgramIdMismatch`. `anchor keys sync` rewrites `declare_id!` and
`Anchor.toml` to match the keypair you just generated. Run it once, then rebuild.

---

## Custom feature: NFT receipt

> A rule that only your TypeScript obeys is not a rule. If the program does not
> enforce it, it does not exist.

### What it does

*Written before any code, and unchanged since.*

**NFT receipt** gives every backer a one-of-one token proving they backed the
campaign. On a backer's first contribution, `contribute` itself creates a
Token-2022 mint at the PDA `["receipt", fundraiser, contributor]` with 0
decimals. It mints exactly one token into the backer's associated token
account, then sets the mint authority to None, so no second copy can ever
exist. The mint has no freeze authority. It carries its own metadata, named
"Fundraiser Receipt #N", with symbol `RCPT`, and the metadata's update authority
is also removed. N is a serial number: the Fundraiser counts receipts in the
order they are issued, and each Contributor records its own. Later
contributions from the same wallet change nothing about the receipt, and a
number is never reused. The receipt can be transferred freely, which is where
the trap is: a backer who refunds should not keep a receipt for money they took
back, but they could send it away first. So `refund` requires the receipt to be
back in the backer's own token account. It burns it, closes that account and
the mint, and returns their rent to the backer. If the receipt is anywhere else,
`refund` fails with `ReceiptNotHeld`. Sending the receipt away does not beat the
rule; it only blocks the sender's own refund until they get it back. The result
is one program-enforced invariant: a receipt exists if and only if its backer's
money is still in the vault or has gone to the maker. On a successful campaign
the receipt stays with whoever holds it, for good. The receipt is proof, not a
claim: it pays nothing, and holding someone else's receipt never lets you refund
their money.

### How it works

**State.** Both fields are appended, so no existing offset moves.

| Account | Field | Meaning |
| --- | --- | --- |
| `Fundraiser` | `receipts_issued: u32` | receipts issued so far, and so the last serial number; only ever goes up |
| `Contributor` | `receipt_number: u32` | this backer's serial, from 1; `0` means no receipt yet |

The receipt itself is two accounts that the backer pays for:

| Account | Address | Contents |
| --- | --- | --- |
| receipt mint (Token-2022) | PDA `["receipt", fundraiser, contributor]` | 0 decimals, supply 1, no mint or freeze authority, MintCloseAuthority = the Fundraiser, MetadataPointer = itself (no authority), TokenMetadata with no update authority |
| receipt token account | the backer's associated token account for that mint | the one token |

The close authority doubles as a pointer back to the campaign. A mint's
address can't be turned back into its seeds, so the close authority is how
anyone holding a receipt can tell which Fundraiser it belongs to.

**Lifecycle.**

```
contribute (first)    creates the mint and the backer's token account, mints 1,
                      removes the mint and metadata authorities,
                      receipt_number = ++receipts_issued
contribute (again)    the receipt is untouched
check_contributions   unchanged; every receipt stays with whoever holds it
refund                supply 1: the receipt must be in the backer's own account,
                      or ReceiptNotHeld; it is burned
                      supply 0: already burned by its holder; nothing to burn
                      then the token account (if still there) and the mint
                      are closed, rent to the backer
```

**Why inside `contribute`.** If the receipt were minted by a separate optional
instruction, "every backer has a receipt" would be a rule only the frontend
obeys. Inside `contribute`, the program guarantees it.

**Why the mint is created by hand.** The obvious tool, `init_if_needed`, has a
trap. When the account already exists, it re-checks the mint authority
(anchor-syn 1.1.2, `constraints.rs:1064`). Once that authority is None, **every
second contribution would fail** with `ConstraintMintMintAuthority`. So
`contribute` creates the mint only when its account is empty, and an empty
receipt account is also what marks a first contribution. Only this program can
allocate that address, so empty really means "no receipt yet". Creating it by
hand means doing what `init` does for free:

- **A pre-funded address.** Anyone can send lamports to an address before it
  exists, and `create_account` refuses an address that holds any. Left
  unhandled, that would lock a backer out of the campaign. The program tops the
  account up, then calls `allocate` and `assign`, as Anchor's own `init` does.
- **The right size.** The account is created at the size of the mint plus its
  two fixed extensions. Token-2022 grows it when it writes the metadata, but the
  lamports for that have to be there already. The extra is sized with
  Token-2022's 4-byte extension header. `TokenMetadata::tlv_size_of` assumes the
  generic 12-byte header and would over-fund every receipt by 8 bytes of rent,
  stranded for good when the campaign succeeds. A test pins the mint to exactly
  rent-exempt.

The CPIs run in the order Token-2022 requires:

1. create the account;
2. add the close-authority and metadata-pointer extensions;
3. initialise the mint;
4. write the metadata;
5. hand its update authority to None. Token-2022 refuses None at
   initialisation, so the Fundraiser holds it for one CPI;
6. create the backer's token account;
7. mint 1;
8. set the mint authority to None.

**Why Token-2022 rather than the classic Token program.** A classic mint can
never be closed, so a refunded receipt's rent, and its address, would be
stranded for good. MintCloseAuthority lets `refund` close it. Token-2022 also
carries the name and symbol on the mint itself. Metaplex metadata would need
the Metaplex program, which `anchor test` and bankrun cannot run without
cloning it in. The raised token stays on the classic Token program; only the
receipt uses Token-2022.

**The refund trap.** Four answers were weighed:

| Policy | Verdict |
| --- | --- |
| The backer keeps the receipt | Rejected: it would be proof of backing that was taken back |
| Soulbound (NonTransferable extension) | Removes the trap, but a receipt could never move to a new wallet or be traded, even after the campaign succeeds |
| The Fundraiser as permanent delegate, burning it wherever it is | Tradeable, but a buyer's receipt could be revoked by someone else's refund, and wallets flag permanent-delegate mints as risky |
| **Refund requires it back in the backer's own account** | **Chosen:** tradeable; sending it away only blocks the sender's own refund |

**`refund` does the burn itself.** The backer signs `refund`, so the program
can burn from their account. A design where the client burns first and the
program only checks would break the original refund tests, which never burn,
and would split one action across two instructions.

**A receipt that is already burned still allows a refund.** Token-2022 always
lets an owner burn, and wallets offer a one-click burn for unknown tokens. If
refund demanded the receipt in that case, the backer's money would be locked in
the vault for good, since no receipt can ever be minted again. So `refund`
reads the supply. At 1, the receipt must be in the backer's own account. At 0,
there is nothing left to burn. Whoever holds a receipt can release the backer's
refund, but only by destroying it.

**Why the receipt token account is checked by hand in `refund`.** A typed
Anchor account would reject a backer who sent the receipt away and closed the
emptied account with a generic `AccountNotInitialized`. Reading it by hand
turns every "the receipt isn't here" case into `ReceiptNotHeld`: wrong owner,
closed, or empty. The mint and owner need no check: the address is the backer's
associated token account, whose owner Token-2022 makes immutable. As a second
lock, Token-2022 refuses to close a mint whose supply is not 0. So even a wrong
burn could not end with the refund done and the receipt still in existence.

| New error | When |
| --- | --- |
| `ReceiptNotHeld` | `refund` while the receipt exists but is not in the backer's own associated token account |
| `MathOverflow` | the serial counter would overflow a `u32` |

New errors are appended, so 6000–6007 keep their numbers.

**Tests.** `tests/nft-receipt.ts` has 12 bankrun tests, bringing the suite to 23.
Each one asserts on accounts, not only on success.

- **happy path:** the receipt minted with every authority removed; a refund
  returning exactly the backer's rent; ten receipts surviving a successful
  campaign, numbered #1 to #10;
- **boundary:** one raw unit under a token mints nothing, and exactly a token
  mints the receipt; a second contribution leaves it byte-identical; serial
  numbers are never freed by a refund; a receipt already burned still allows a
  refund;
- **abuse:** `ReceiptNotHeld` while a friend holds the receipt, and after the
  backer closed their emptied account; no second mint and no freeze; a
  pre-funded address; another backer's receipt accounts (`ConstraintSeeds`).

Nine deliberate breaks were each caught:

- keeping the mint authority, the metadata update authority, or a freeze
  authority;
- a serial counter that never advances;
- dropping the pre-funded-address handling;
- over-funding the rent;
- dropping the held check;
- a refund that ignores the receipt;
- a refund that refuses an already-burned receipt.

### What it costs

Measured on bankrun, on the base program and on this branch, both built with
the same program ID and driven with fixed keypairs, so every PDA and bump is
identical:

| | Base | NFT receipt | Added |
| --- | --- | --- | --- |
| `initialize` | 45,100 CU | 45,153 CU | +53 CU (larger account) |
| `contribute`, first | 37,232 CU | 128,389 CU | **+91,157 CU**: the receipt, 9 CPIs |
| `contribute`, repeat | 34,588 CU | 42,259 CU | +7,671 CU: re-deriving the two receipt addresses |
| `check_contributions` | 47,295 CU | 47,299 CU | unchanged |
| `refund` | 23,505 CU | 50,295 CU | +26,790 CU: burn and two closes |
| `Fundraiser` | 98 bytes, 1,572,960 lamports | 102 bytes, 1,600,800 lamports | +27,840 lamports, paid by the maker and returned at settlement |
| `Contributor` | 16 bytes, 1,002,240 lamports | 20 bytes, 1,030,080 lamports | +27,840 lamports per backer |
| receipt mint | n/a | 379 bytes, 3,528,720 lamports | new, per backer |
| receipt token account | n/a | 170 bytes, 2,074,080 lamports | new, per backer |

- **Rent for a backer:** a first contribution locks 6,632,880 lamports of rent
  instead of 1,002,240, which is **+5,630,640 lamports (about 0.0056 SOL)**.
  - On a refund, every lamport comes back (measured: net 0).
  - On a success, it stays locked while the receipt exists. The holder can
    burn the receipt and close their token account to recover 2,074,080
    lamports. The mint's rent is gone for good, because only `refund` ever
    signs as its close authority.
  - For a cheap token, the receipt's rent can be worth more than a one-token
    contribution.
- **Extra accounts:** `contribute` goes from 8 accounts to 12, and `refund` from
  9 to 13. The new ones are the Token-2022 program, the Associated Token
  program, the receipt mint and the receipt token account. That is 128 more
  bytes of transaction. Every one is a PDA or a fixed program ID, so clients
  derive them, and the original tests pass unedited.
- **Compute headroom:** a first contribution ranges from 119,389 to 137,389 CU
  across the ten fixed backers, depending on how many tries each PDA bump
  takes. That is within the default 200,000 per instruction. A frontend that
  bundles other instructions with it should raise the compute limit.
- **The repeat-contribution cost is avoidable:** the `seeds` checks re-run
  `find_program_address` for both receipt addresses on every contribution.
  Storing the two bumps on `Contributor` would cut most of the +7,671 CU, at a
  cost of 2 bytes of rent per backer. It is left out to keep the state minimal.

### How you would attack it

1. **Pre-fund the receipt address to lock a backer out.** Refused. Sending
   lamports to the address before the first contribution no longer blocks it
   (tested). It costs the attacker at least the rent-exempt minimum for an
   empty account, 890,880 lamports. The program counts those lamports toward
   the receipt's rent, so the backer pays that much less, and gets it back on a
   refund.
2. **Hold a receipt hostage.** A backer who sells or lends their receipt while
   the campaign is live gives the holder a veto over their refund. The holder
   can keep it, return it, or burn it. That is the design working as intended:
   the receipt cannot outlive its backing. It still means a receipt bought
   before a campaign resolves can be used to extort the original backer. The
   rule for backers is to not hand the receipt over until the campaign has
   succeeded.
3. **Buy a receipt to claim the refund.** Impossible. `refund` pays the backer
   named by the Contributor PDA, which is derived from the signer. It burns
   only the signer's own receipt, and another backer's receipt accounts fail
   `ConstraintSeeds` (tested). The receipt gates a refund; it never pays one.
4. **Destroy your own receipt.** The paragraph's "if and only if" has one
   exception, and it is the backer themselves. Token-2022 always lets an owner
   burn, so a backer can have committed money and no receipt. The program
   enforces the direction that matters: a receipt never outlives its backing.
   It also makes sure a burned receipt never locks the money in (tested).
5. **Mint a second copy, freeze one, rename one, or repoint the metadata.** The
   mint authority, the freeze authority, the metadata update authority and the
   metadata-pointer authority are all None (tested). **Even an upgraded program
   cannot destroy a held receipt.** It can close the mint only at supply 0, and
   it cannot burn a token it does not own, because there is no permanent
   delegate.
6. **Fake receipts.** Anyone can create a Token-2022 mint named "Fundraiser
   Receipt #1" with symbol `RCPT`. Metadata is not proof. A verifier must check
   that the mint's address is the PDA
   `["receipt", fundraiser, contributor]` under this program ID, and that its
   close authority is that Fundraiser.
7. **Stale Contributor PDAs from the base program.** The original program never
   closes Contributor PDAs on success, and the maker can re-initialize at the
   same Fundraiser address. A backer returning to campaign B therefore:
   - already has campaign A's receipt at the same address, so gets no new
     receipt, and A's receipt stands in for B;
   - sees serial numbers restart at #1 in B, so two receipts can carry the same
     name for the same Fundraiser address;
   - if B fails, must hold A's receipt to refund B. The refund then burns proof
     of a campaign that succeeded, on top of the base program's own bug of
     refunding A's stale amount out of B's vault.

   The seeds are fixed by the brief, so the fix is to close stale PDAs. That is
   the lifecycle feature's job, not this one's.
8. **Sybil backers.** The 10% per-wallet cap does not stop one person using many
   wallets. The number of receipts counts wallets, not people. Each extra
   wallet costs its owner about 0.0056 SOL of rent, which a successful
   campaign never returns.

This example demonstrates how to create a fundraising for SPL Tokens.

In this example, a user will be able to create a fundraiser account, where he will be specify the mint he wants to collect and the fundraising target.

---

## Let's walk through the architecture:

A fundraising account consists of:

```rust
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
}
```

### In this state account, we will store:

- maker: the person who is starting the fundraising

- mint_to_raise: the mint that the maker wants to receive

- amount_to_raise: the target amount that the maker is trying to raise

- current_amount: the total amount currently donated

- time_started: the time when the account was created

- duration: the timeframe to collect all the contributions (in days) 

- bump: since our Fundraiser account will be a PDA (Program Derived Address), we will store the bump of the account

We use InitSpace derive macro to implement the space triat that will calculate the amount of space that our account will use on-chain (without taking the anchor discriminator into consideration)

---

### The user will be able to create new Fundraiser accounts. For that, we create the following context:

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        init,
        payer = maker,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Fundraiser::INIT_SPACE,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

Let´s have a closer look at the accounts that we are passing in this context:

- maker: will be the person starting the fundraising. He will be a signer of the transaction, and we mark his account as mutable as we will be deducting lamports from this account

- mint_to_raise: The mint that the user wants to receive. This will be a Mint Account, that we will use to store the mint address

- fundraiser: will be the state account that we will initialize and the maker will be paying for the initialization of the account.
We derive the Fundraiser PDA from the byte representation of the word "fundraiser" and the reference of the maker publick key. Anchor will calculate the canonical bump (the first bump that throes that address out of the ed25519 eliptic curve) and save it for us in a struct

- vault: We will initialize a vault (ATA) to receive the contributions. This account will be derived from the mint that the user wants to receive, and the fundraiser account that we are just creating

- system_program: Program resposible for the initialization of any new account

- token_program and associated_token_program: We are creating new ATAs

### We then implement some functionality for our Initialize context:

```rust
impl<'info> Initialize<'info> {
    pub fn initialize(&mut self, amount: u64, duration: u8, bumps: &InitializeBumps) -> Result<()> {

        // Check if the amount to raise meets the minimum amount required
        require!(
            amount > MIN_AMOUNT_TO_RAISE.pow(self.mint_to_raise.decimals as u32),
            FundraiserError::InvalidAmount
        );

        // Initialize the fundraiser account
        self.fundraiser.set_inner(Fundraiser {
            maker: self.maker.key(),
            mint_to_raise: self.mint_to_raise.key(),
            amount_to_raise: amount,
            current_amount: 0,
            time_started: Clock::get()?.unix_timestamp,
            duration,
            bump: bumps.fundraiser
        });
        
        Ok(())
    }
}
```

In here, we basically just set the data of our Fundraiser account if the amount to raise is bigger than 3 (minimum amount)

---

### Users will be able to contribute to a fundraising

A contribution account consists of:

```rust
#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
}
```rust

In this account we will only store the total amount contributed by a specific contributor

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
}
```

In this context, we are passing all the accounts needed to contribute to a fundraising campaign:

- contributor: The address of the person that is contributing

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- contributor account: We initialize (if needed) a contributor account that will store the total amount that a specific contributor has contributed with so far

- contributor_ata: The ata where we will be transfering tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and contributor address), and we mark it as mutable since we will be deducting tokens from that account

- vault: The ata where we will be depositing tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and Fundraiser account), and we mark it as mutable since we will be depositing tokens in that account

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Contribute context:

```rust
impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64) -> Result<()> {

        // Check if the amount to contribute meets the minimum amount required
        require!(
            amount > 1_u8.pow(self.mint_to_raise.decimals as u32) as u64, 
            FundraiserError::ContributionTooSmall
        );

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER, 
            FundraiserError::ContributionTooBig
        );

        // Check if the maximum contributions per contributor have been reached
        require!(
            (self.contributor_account.amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER),
            FundraiserError::MaximumContributionsReached
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            self.fundraiser.duration <= ((current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS) as u8,
            crate::FundraiserError::FundraisingEnded
        );

        // Transfer the funds to the vault
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the contributor to the vault
        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        // Crete a CPI context
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Transfer the funds from the contributor to the vault
        transfer(cpi_ctx, amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount += amount;

        self.contributor_account.amount += amount;

        Ok(())
    }
}
```
In here, we make some checks:
- We check that the user is depositing at least one token

- We Check that the user is not contributiong with more than 10% of the target amount

- We check that the total contributions of the user do not exceed a total of 10% of the target amount

- We check that the fundraising duration has not elapsed

After, we create a CPI to the token program, to transfer a certain amount of SPL tokens from the Contributor ATA to the vault.
We pass the authority of the account where the tokens are being deducted from (In this case is the contributor, as he is the authority of the contributor ata).

Lastly, we update our state acounts with the right amounts

---

### User will be able to claim the tokens once the fundraiding target has been reached

```rust
#[derive(Accounts)]
pub struct CheckContributions<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
        close = maker,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

In this context, we are passing all the accounts needed for a user to claim the raised tokens:

- maker: The address of the person raising the the funds. We mark it as mutable since the maker will be paying for initialization fees and will receive lamports from rent back

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- vault: The ata where we will be transfering tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and fundraiser account), and we mark it as mutable since we will be deducting tokens from that account

- maker_ata: The ata where we will be depositing tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and maker account), and we mark it as mutable since we will be depositing tokens in that account.
In case we need to initialize this ATA, the maker will be paying for the initialization fees

- system_program and associated_token_program: Since we are initializing new ATAs

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Contribute context:

```rust
impl<'info> CheckContributions<'info> {
    pub fn check_contributions(&self) -> Result<()> {
        
        // Check if the target amount has been met
        require!(
            self.vault.amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        // Transfer the funds to the maker
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the vault to the maker
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.maker_ata.to_account_info(),
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

        // Transfer the funds from the vault to the maker
        transfer(cpi_ctx, self.vault.amount)?;

        Ok(())
    }
}
```

In this implementation, we check if the amount of tokens in the vault is equal or bigger then the fundraising campaign target.
If it is, then we perform a CPI to the token program to transfer the funds from the vault to the maker ATA. Since the vault is an ATA, we need to create our CPI contexr with a signer and use the seeds and bump from the PDA (We are signing with our program on behalf of that PDA).

Finally, we close our Fundraiser account and send the lamports from the rent back to the maker (done with the "close" constraint int the Fundraiser account).


---

### Users will be able to refund their contributions, if the duration of the fundraising has elapsed and the target has not reached

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
}

In this context, we are passing all the accounts needed for a contributor to refund their tokens:

- contributor: The address of the person that is contributing

- maker: The address of the person raising the the funds.

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- contributor account: An initialized Contributor account that will store the total amount that a specific contributor has contributed with so far

- contributor_ata: The ata where we will be transfering tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and contributor address), and we mark it as mutable since we will be depositing tokens to that account

- vault: The ata where we will be withdrawing tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and Fundraiser account), and we mark it as mutable since we will be withdrawing tokens from that account

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Refund context:

```rust
impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
 
        require!(
            self.fundraiser.duration <= ((current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS) as u8,
            crate::FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

        // Transfer the funds back to the contributor
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

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
}
```

In here, we will check if the fundrasing has already met the target and if ir passed the duration time.
After doing the proper checks, we transfer the donated funds from the vault back to the contributor
