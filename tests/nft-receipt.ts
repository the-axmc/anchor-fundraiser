import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock, ProgramTestContext } from "solana-bankrun";
import {
  ExtensionType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createFreezeAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getExtensionData,
  getMetadataPointerState,
  getMintCloseAuthority,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

/**
 * NFT receipt: a backer's first contribution creates a Token-2022 mint at
 * ["receipt", fundraiser, contributor] and mints its one token to them, then
 * removes every authority that could add, freeze or rename it. `refund`
 * requires the receipt back in the backer's own account (or already burned),
 * burns it, and closes its accounts.
 *
 * Runs on bankrun because refunds only open once the clock has passed the
 * deadline.
 */
describe("fundraiser — NFT receipt (bankrun)", () => {
  // The per-contributor cap is 10% of the target and contribute needs at least
  // one whole token, so a 20 token target lets a backer contribute twice.
  const TOKEN = 1_000_000;
  const TARGET = 20 * TOKEN;
  const DURATION_DAYS = 7;

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    const idl = require("../target/idl/fundraiser.json");
    program = new anchor.Program<Fundraiser>(idl, provider);
    payer = context.payer;
  });

  /**
   * Signs with the payer plus any extras, and runs it.
   *
   * Two identical transactions on one blockhash are the same transaction, and
   * the bank rejects the second as already processed before the program runs.
   * A priority fee that changes every time makes each transaction unique. The
   * payer pays every fee, so a backer's lamports move only by rent.
   */
  let nonce = 0;
  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction();
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ++nonce }));
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  };

  /** Rethrows chai's AssertionError so an `assert.fail` in a `try` is not swallowed. */
  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;

    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;

    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];

    // Bankrun reports only the number. Ours are in the IDL; Anchor's own
    // (ConstraintSeeds is 2006) are in LangErrorCode.
    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const known = (program.idl.errors ?? []).find((e: any) => e.code === code);
      if (known) return known.name;
      const lang = Object.entries(anchor.LangErrorCode).find(([, value]) => value === code);
      if (lang) return lang[0];
      return `custom error ${code}`;
    }

    return text.slice(0, 300);
  };

  /** Runs `attempt` and asserts it is rejected with `expected`. */
  const assertRejects = async (attempt: () => Promise<unknown>, expected: string, why: string) => {
    try {
      await attempt();
      assert.fail(`${why}: expected ${expected}, but the transaction succeeded`);
    } catch (err) {
      const actual = errorCodeOf(err);
      assert.strictEqual(
        actual.toLowerCase(),
        expected.toLowerCase(),
        `${why} (expected ${expected}, got ${actual})`
      );
    }
  };

  /** Runs `attempt` and asserts it is rejected, for errors from other programs. */
  const assertFails = async (attempt: () => Promise<unknown>, why: string) => {
    try {
      await attempt();
    } catch (err) {
      if (err instanceof AssertionError) throw err;
      return;
    }
    assert.fail(`${why}, but the transaction succeeded`);
  };

  const advanceDays = async (days: number) => {
    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + BigInt(days) * 86400n
      )
    );
  };

  // ------------------------------------------------------------------
  // Reading accounts
  // ------------------------------------------------------------------

  const account = (address: anchor.web3.PublicKey) => context.banksClient.getAccount(address);

  const lamportsOf = async (address: anchor.web3.PublicKey) =>
    BigInt((await account(address))?.lamports ?? 0);

  const asInfo = (raw: any) => ({ ...raw, data: Buffer.from(raw.data), owner: new anchor.web3.PublicKey(raw.owner) });

  /** The receipt mint, or null once it has been closed. */
  const readMint = async (address: anchor.web3.PublicKey) => {
    const raw = await account(address);
    return raw ? unpackMint(address, asInfo(raw), TOKEN_2022_PROGRAM_ID) : null;
  };

  /** A Token-2022 token account, or null if it does not exist. */
  const readTokenAccount = async (address: anchor.web3.PublicKey) => {
    const raw = await account(address);
    return raw ? unpackAccount(address, asInfo(raw), TOKEN_2022_PROGRAM_ID) : null;
  };

  const classicBalance = async (address: anchor.web3.PublicKey) => {
    const raw = await account(address);
    return unpackAccount(address, asInfo(raw), TOKEN_PROGRAM_ID).amount;
  };

  /**
   * The TokenMetadata extension, decoded by hand: update authority (32 bytes,
   * all zeros for None), mint (32), then name, symbol and uri, each a u32
   * length and UTF-8 bytes.
   */
  const metadataOf = (mint: NonNullable<Awaited<ReturnType<typeof readMint>>>) => {
    const data = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData)!;
    let offset = 64;
    const text = () => {
      const length = data.readUInt32LE(offset);
      const value = data.subarray(offset + 4, offset + 4 + length).toString("utf8");
      offset += 4 + length;
      return value;
    };
    return {
      updateAuthority: new anchor.web3.PublicKey(data.subarray(0, 32)),
      mint: new anchor.web3.PublicKey(data.subarray(32, 64)),
      name: text(),
      symbol: text(),
      uri: text(),
    };
  };

  // ------------------------------------------------------------------
  // Campaigns and backers
  // ------------------------------------------------------------------

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  type Backer = {
    keypair: anchor.web3.Keypair;
    ata: anchor.web3.PublicKey;
    account: anchor.web3.PublicKey;
    receipt: anchor.web3.PublicKey;
    receiptAta: anchor.web3.PublicKey;
  };

  /** A fresh mint and a seven day, 20 token fundraiser for a new maker. */
  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    await send(
      [
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: maker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
      ],
      [mintKeypair]
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await send(
      [
        await program.methods
          .initialize(new anchor.BN(TARGET), DURATION_DAYS)
          .accountsPartial({ maker: maker.publicKey, mintToRaise: mint, fundraiser, vault })
          .instruction(),
      ],
      [maker]
    );

    return { maker, mint, fundraiser, vault };
  };

  /** A wallet with SOL for rent and 10 tokens of `c`'s mint. */
  const newBacker = async (c: Campaign): Promise<Backer> => {
    const keypair = anchor.web3.Keypair.generate();
    const ata = getAssociatedTokenAddressSync(c.mint, keypair.publicKey);
    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: keypair.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL / 10,
      }),
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, keypair.publicKey, c.mint),
      createMintToInstruction(c.mint, ata, payer.publicKey, 10 * TOKEN),
    ]);
    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), keypair.publicKey.toBuffer()],
      program.programId
    );
    const [receipt] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), c.fundraiser.toBuffer(), keypair.publicKey.toBuffer()],
      program.programId
    );
    const receiptAta = getAssociatedTokenAddressSync(receipt, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID);
    return { keypair, ata, account, receipt, receiptAta };
  };

  // The receipt accounts are left out on purpose: they are PDAs, so the client
  // derives them, exactly as it does for the original tests.
  const contributeIx = (c: Campaign, who: Backer, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: who.keypair.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: who.account,
        contributorAta: who.ata,
        vault: c.vault,
      });

  const contribute = async (c: Campaign, who: Backer, amount = TOKEN) =>
    send([await contributeIx(c, who, amount).instruction()], [who.keypair]);

  const refundIx = (c: Campaign, who: Backer) =>
    program.methods.refund().accountsPartial({
      contributor: who.keypair.publicKey,
      maker: c.maker.publicKey,
      mintToRaise: c.mint,
      fundraiser: c.fundraiser,
      contributorAccount: who.account,
      contributorAta: who.ata,
      vault: c.vault,
    });

  const refund = async (c: Campaign, who: Backer) =>
    send([await refundIx(c, who).instruction()], [who.keypair]);

  /** Hands `who`'s receipt to a new wallet, and returns that wallet's account. */
  const giveReceiptAway = async (who: Backer) => {
    const friend = anchor.web3.Keypair.generate();
    const friendAta = getAssociatedTokenAddressSync(who.receipt, friend.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await send(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, friendAta, friend.publicKey, who.receipt, TOKEN_2022_PROGRAM_ID
        ),
        createTransferCheckedInstruction(
          who.receiptAta, who.receipt, friendAta, who.keypair.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID
        ),
      ],
      [who.keypair]
    );
    return { friend, friendAta };
  };

  const receiptNumberOf = async (who: Backer) =>
    (await program.account.contributor.fetch(who.account)).receiptNumber;

  const receiptsIssued = async (c: Campaign) =>
    (await program.account.fundraiser.fetch(c.fundraiser)).receiptsIssued;

  // ------------------------------------------------------------------
  // Happy path
  // ------------------------------------------------------------------

  it("mints one receipt on the first contribution, with every authority removed", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);

    await contribute(c, alice);

    const raw = await account(alice.receipt);
    assert.ok(raw, "the receipt mint should exist");
    assert.ok(new anchor.web3.PublicKey(raw!.owner).equals(TOKEN_2022_PROGRAM_ID), "it should be a Token-2022 mint");

    const mint = (await readMint(alice.receipt))!;
    assert.strictEqual(mint.decimals, 0, "an NFT has 0 decimals");
    assert.strictEqual(mint.supply, 1n, "exactly one receipt");
    assert.isNull(mint.mintAuthority, "no mint authority, so no second copy");
    assert.isNull(mint.freezeAuthority, "no freeze authority, so nobody can block a refund");
    assert.ok(getMintCloseAuthority(mint)!.closeAuthority.equals(c.fundraiser), "the fundraiser can close it");

    const pointer = getMetadataPointerState(mint)!;
    assert.ok(pointer.metadataAddress!.equals(alice.receipt), "the metadata lives on the mint itself");
    assert.isNull(pointer.authority, "nobody can point the metadata elsewhere");

    const metadata = metadataOf(mint);
    assert.strictEqual(metadata.name, "Fundraiser Receipt #1");
    assert.strictEqual(metadata.symbol, "RCPT");
    assert.ok(metadata.mint.equals(alice.receipt));
    assert.ok(metadata.updateAuthority.equals(anchor.web3.PublicKey.default), "nobody can rename it");

    const held = (await readTokenAccount(alice.receiptAta))!;
    assert.strictEqual(held.amount, 1n, "the backer holds it");
    assert.ok(held.owner.equals(alice.keypair.publicKey));

    assert.strictEqual(await receiptsIssued(c), 1);
    assert.strictEqual(await receiptNumberOf(alice), 1);
  });

  it("refund burns the receipt and returns all of its rent to the backer", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);
    await contribute(c, alice);

    const rent =
      (await lamportsOf(alice.receipt)) + (await lamportsOf(alice.receiptAta)) + (await lamportsOf(alice.account));
    const before = await lamportsOf(alice.keypair.publicKey);

    await advanceDays(DURATION_DAYS + 1);
    await refund(c, alice);

    assert.isNull(await account(alice.receipt), "the receipt mint should be closed");
    assert.isNull(await account(alice.receiptAta), "the receipt token account should be closed");
    assert.isNull(await account(alice.account), "the Contributor account should be closed");
    assert.strictEqual(
      (await lamportsOf(alice.keypair.publicKey)) - before,
      rent,
      "every lamport of rent should be back with the backer"
    );
    assert.strictEqual(await classicBalance(alice.ata), BigInt(10 * TOKEN), "and every token");
    assert.strictEqual(await classicBalance(c.vault), 0n);
    assert.strictEqual(await receiptsIssued(c), 1, "a refund does not un-issue a serial number");
  });

  it("a successful campaign leaves every backer holding their receipt", async () => {
    const c = await openCampaign();
    const backers: Backer[] = [];
    for (let i = 0; i < 10; i++) {
      const who = await newBacker(c);
      await contribute(c, who, 2 * TOKEN);
      backers.push(who);
    }

    await send(
      [
        await program.methods
          .checkContributions()
          .accountsPartial({ maker: c.maker.publicKey, mintToRaise: c.mint, fundraiser: c.fundraiser, vault: c.vault })
          .instruction(),
      ],
      [c.maker]
    );
    assert.isNull(await account(c.fundraiser), "the maker has been paid and the Fundraiser closed");

    for (const [i, who] of backers.entries()) {
      const mint = (await readMint(who.receipt))!;
      assert.strictEqual(mint.supply, 1n, `backer ${i + 1} should still have a receipt`);
      assert.strictEqual((await readTokenAccount(who.receiptAta))!.amount, 1n);
      assert.strictEqual(metadataOf(mint).name, `Fundraiser Receipt #${i + 1}`, "numbered in the order issued");
      assert.strictEqual(await receiptNumberOf(who), i + 1);
    }
  });

  // ------------------------------------------------------------------
  // Boundary
  // ------------------------------------------------------------------

  it("one raw unit short of a token mints nothing; exactly one token mints the receipt", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);

    await assertRejects(
      () => contribute(c, alice, TOKEN - 1),
      "ContributionTooSmall",
      "a contribution one raw unit under a whole token should be refused"
    );
    assert.isNull(await account(alice.receipt), "a refused contribution must not leave a receipt");
    assert.strictEqual(await receiptsIssued(c), 0);

    await contribute(c, alice, TOKEN);
    assert.strictEqual((await readMint(alice.receipt))!.supply, 1n);
    assert.strictEqual(await receiptsIssued(c), 1);
  });

  it("a second contribution leaves the receipt exactly as it was", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);
    await contribute(c, alice);

    const mintBefore = Buffer.from((await account(alice.receipt))!.data);
    const ataBefore = Buffer.from((await account(alice.receiptAta))!.data);

    await contribute(c, alice);

    assert.ok(Buffer.from((await account(alice.receipt))!.data).equals(mintBefore), "the mint is untouched");
    assert.ok(Buffer.from((await account(alice.receiptAta))!.data).equals(ataBefore), "still exactly one, held");
    assert.strictEqual(await receiptsIssued(c), 1, "no second serial number");
    assert.strictEqual(await receiptNumberOf(alice), 1);
    assert.strictEqual(
      (await program.account.contributor.fetch(alice.account)).amount.toNumber(),
      2 * TOKEN,
      "the contribution itself still counts"
    );
  });

  it("serial numbers follow issue order, and a refund does not free one", async () => {
    const c = await openCampaign();
    const backers = [await newBacker(c), await newBacker(c), await newBacker(c)];
    for (const who of backers) await contribute(c, who);

    assert.deepEqual(
      await Promise.all(backers.map(receiptNumberOf)),
      [1, 2, 3],
      "the first backer is #1"
    );

    await advanceDays(DURATION_DAYS + 1);
    await refund(c, backers[1]);

    assert.strictEqual(await receiptsIssued(c), 3, "the counter only goes up");
    assert.strictEqual(metadataOf((await readMint(backers[0].receipt))!).name, "Fundraiser Receipt #1");
    assert.strictEqual(metadataOf((await readMint(backers[2].receipt))!).name, "Fundraiser Receipt #3");
  });

  it("a backer whose receipt was already burned can still refund", async () => {
    // Token-2022 always lets an owner burn, and wallets offer it for unknown
    // tokens. Refusing the refund then would lock the money in the vault.
    const c = await openCampaign();
    const alice = await newBacker(c);
    const bob = await newBacker(c);
    await contribute(c, alice);
    await contribute(c, bob);

    await send(
      [createBurnInstruction(alice.receiptAta, alice.receipt, alice.keypair.publicKey, 1, [], TOKEN_2022_PROGRAM_ID)],
      [alice.keypair]
    );
    // Bob burns it and closes the empty account too.
    await send(
      [
        createBurnInstruction(bob.receiptAta, bob.receipt, bob.keypair.publicKey, 1, [], TOKEN_2022_PROGRAM_ID),
        createCloseAccountInstruction(
          bob.receiptAta, bob.keypair.publicKey, bob.keypair.publicKey, [], TOKEN_2022_PROGRAM_ID
        ),
      ],
      [bob.keypair]
    );

    await advanceDays(DURATION_DAYS + 1);
    await refund(c, alice);
    await refund(c, bob);

    for (const who of [alice, bob]) {
      assert.strictEqual(await classicBalance(who.ata), BigInt(10 * TOKEN), "the money should be back");
      assert.isNull(await account(who.receipt), "and the mint closed");
      assert.isNull(await account(who.receiptAta));
    }
  });

  // ------------------------------------------------------------------
  // Abuse
  // ------------------------------------------------------------------

  it("refuses a refund while someone else holds the receipt", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);
    await contribute(c, alice);
    const { friend, friendAta } = await giveReceiptAway(alice);

    await advanceDays(DURATION_DAYS + 1);
    await assertRejects(
      () => refund(c, alice),
      "ReceiptNotHeld",
      "a backer must not get their money back while their receipt lives on elsewhere"
    );
    assert.strictEqual(await classicBalance(c.vault), BigInt(TOKEN), "the money stays in the vault");
    assert.ok(await account(alice.account), "the Contributor account is still open");
    assert.strictEqual((await readTokenAccount(friendAta))!.amount, 1n, "the friend still holds the receipt");

    // Once it is back, the refund goes through, and the receipt is gone.
    await send(
      [createTransferCheckedInstruction(
        friendAta, alice.receipt, alice.receiptAta, friend.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID
      )],
      [friend]
    );
    await refund(c, alice);
    assert.isNull(await account(alice.receipt));
    assert.strictEqual(await classicBalance(alice.ata), BigInt(10 * TOKEN));
  });

  it("refuses with ReceiptNotHeld even after the backer closes their emptied account", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);
    await contribute(c, alice);
    await giveReceiptAway(alice);
    await send(
      [createCloseAccountInstruction(
        alice.receiptAta, alice.keypair.publicKey, alice.keypair.publicKey, [], TOKEN_2022_PROGRAM_ID
      )],
      [alice.keypair]
    );
    assert.isNull(await account(alice.receiptAta));

    await advanceDays(DURATION_DAYS + 1);
    await assertRejects(
      () => refund(c, alice),
      "ReceiptNotHeld",
      "a closed account must not look like a burned receipt"
    );
    assert.strictEqual(await classicBalance(c.vault), BigInt(TOKEN));
  });

  it("nobody can mint a second receipt or freeze one", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);
    await contribute(c, alice);

    for (const signer of [payer, alice.keypair]) {
      await assertFails(
        () => send(
          [createMintToInstruction(alice.receipt, alice.receiptAta, signer.publicKey, 1, [], TOKEN_2022_PROGRAM_ID)],
          signer === payer ? [] : [signer]
        ),
        "a second receipt should be impossible to mint"
      );
      await assertFails(
        () => send(
          [createFreezeAccountInstruction(alice.receiptAta, alice.receipt, signer.publicKey, [], TOKEN_2022_PROGRAM_ID)],
          signer === payer ? [] : [signer]
        ),
        "the receipt should be impossible to freeze"
      );
    }

    assert.strictEqual((await readMint(alice.receipt))!.supply, 1n);
    assert.isFalse((await readTokenAccount(alice.receiptAta))!.isFrozen);
  });

  it("an address pre-funded with lamports does not block the first contribution", async () => {
    // create_account refuses an address that already holds lamports. Anyone
    // can send them, so this would lock a backer out if it were not handled.
    const c = await openCampaign();
    const alice = await newBacker(c);
    const rent = await context.banksClient.getRent();
    const gift = rent.minimumBalance(0n);
    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: alice.receipt,
        lamports: Number(gift),
      }),
    ]);

    await contribute(c, alice);

    const raw = (await account(alice.receipt))!;
    assert.strictEqual((await readMint(alice.receipt))!.supply, 1n, "the receipt is minted as usual");
    assert.strictEqual(
      BigInt(raw.lamports),
      rent.minimumBalance(BigInt(raw.data.length)),
      "topped up to exactly rent-exempt, no more"
    );
  });

  it("refuses another backer's receipt accounts", async () => {
    const c = await openCampaign();
    const alice = await newBacker(c);
    const bob = await newBacker(c);
    await contribute(c, alice);
    await contribute(c, bob);

    // Alice tries to add to her contribution while pointing at Bob's receipt.
    await assertRejects(
      async () => send(
        [await contributeIx(c, alice, TOKEN).accountsPartial({ receiptMint: bob.receipt }).instruction()],
        [alice.keypair]
      ),
      "ConstraintSeeds",
      "contribute must only ever touch the signer's own receipt"
    );

    // And to refund against Bob's receipt instead of her own.
    await advanceDays(DURATION_DAYS + 1);
    await assertRejects(
      async () => send(
        [await refundIx(c, alice).accountsPartial({ receiptMint: bob.receipt, contributorReceiptAta: bob.receiptAta }).instruction()],
        [alice.keypair]
      ),
      "ConstraintSeeds",
      "refund must only ever burn the signer's own receipt"
    );
    assert.strictEqual((await readTokenAccount(bob.receiptAta))!.amount, 1n, "Bob's receipt is untouched");
  });
});
