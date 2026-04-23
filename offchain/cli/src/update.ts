import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Constr,
  getAddressDetails,
  type OutRef,
  type UTxO,
} from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  makeCoordinatorValidator,
  makePairStateValidator,
  makePaymentHookValidator,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "./contracts.js";
import {
  diaIntentToState,
  diaPairIdHex,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  recoverDiaOracleIntentWitness,
  type DiaOracleIntent,
  type DiaOracleIntentInput,
} from "./dia-intent.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "./lucid.js";
import { readPairState, type PairStateArtifact } from "./state.js";

type UpdateInput = {
  intent: DiaOracleIntentInput;
};

export async function submitOracleUpdate(args: {
  inputPath: string;
  statePath: string;
  buildOnly: boolean;
}): Promise<PairStateArtifact> {
  reportProgress(`Loading oracle update input from ${path.resolve(args.inputPath)}`);
  const inputPath = path.resolve(args.inputPath);
  const input = await readUpdateInput(inputPath);

  const statePath = path.resolve(args.statePath);
  reportProgress(`Loading pair state from ${statePath}`);
  const state = await readPairState(statePath);

  if (!state.bootstrapRefs.paymentHook?.txHash) {
    throw new Error("Pair state artifact is missing the payment-hook bootstrap reference.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );
  const currentPairUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.pair.pairValidatorAddress,
    state.pair.pairUnit,
    "pair",
  );
  const currentPaymentHookUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.paymentHookValidatorAddress!,
    state.scripts.paymentHookUnit!,
    "payment hook",
  );
  const walletFundingUtxo = selectFundingUtxo(walletUtxos, [
    state.bootstrapRefs.config,
    state.bootstrapRefs.paymentHook,
  ]);
  if (!walletFundingUtxo) {
    throw new Error("No suitable wallet UTxO is available to cover update fees and collateral.");
  }

  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const pairValidator = await makePairStateValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  if (pairValidatorHash !== state.scripts.pairValidatorHash) {
    throw new Error("Pair validator hash does not match the current blueprint.");
  }

  const paymentHookValidator = await makePaymentHookValidator({
    bootstrapOutRef: state.bootstrapRefs.paymentHook as OutRef,
    assetName: splitUnit(state.scripts.paymentHookUnit!).assetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookValidatorHash = scriptHashFromValidator(paymentHookValidator);
  if (paymentHookValidatorHash !== state.scripts.paymentHookValidatorHash) {
    throw new Error("Payment hook validator hash does not match the current blueprint.");
  }

  const coordinatorValidator = await makeCoordinatorValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    pairPolicyId: state.scripts.pairPolicyId,
  });

  const intent = normalizeDiaOracleIntent(input.intent);
  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });
  const witness = recoverDiaOracleIntentWitness(domain, intent);
  if (!state.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
    throw new Error(
      "The recovered DIA signer public key is not authorized in the provided config state.",
    );
  }

  if (
    normalizeHex(state.pair.pairId, "pair.pairId") !==
    normalizeHex(diaPairIdHex(intent), "intent.symbol")
  ) {
    throw new Error(`Intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
  }

  if (BigInt(intent.timestamp) <= BigInt(state.pairState.timestamp)) {
    throw new Error("Oracle intent timestamp must be greater than the current timestamp.");
  }
  if (BigInt(intent.nonce) <= BigInt(state.pairState.nonce)) {
    throw new Error("Oracle intent nonce must be greater than the current nonce.");
  }

  const nextPairState = {
    ...state.pairState,
    price: intent.price.toString(),
    timestamp: intent.timestamp.toString(),
    nonce: intent.nonce.toString(),
    intentHash: witness.intentHash,
    signer: intent.signer,
    intent: diaIntentToState(intent),
  };
  const nextPaymentHookState = {
    ...state.paymentHookState,
    accruedFeesLovelace: (
      BigInt(state.paymentHookState.accruedFeesLovelace) +
      BigInt(state.paymentHookState.protocolFeePerTxLovelace)
    ).toString(),
    lifetimeFeesCollectedLovelace: (
      BigInt(state.paymentHookState.lifetimeFeesCollectedLovelace) +
      BigInt(state.paymentHookState.protocolFeePerTxLovelace)
    ).toString(),
    feeChargeCount: (BigInt(state.paymentHookState.feeChargeCount) + 1n).toString(),
  };

  const pairRedeemer = Data.to(new Constr(0, []));
  const paymentHookRedeemer = Data.to(new Constr(0, []));
  const coordinatorRedeemer = Data.to(
    new Constr<PlutusData>(0, [updateWitnessData(intent, state.pair.tokenName, witness.signerPublicKey)]),
  );
  const nextPairDatumCbor = buildPairDatumCbor(nextPairState);
  const nextPaymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);

  reportProgress("Building Preview oracle update transaction");
  const txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo])
    .collectFrom([currentPairUtxo], pairRedeemer)
    .collectFrom([currentPaymentHookUtxo], paymentHookRedeemer)
    .collectFrom([walletFundingUtxo])
    .attach.SpendingValidator(pairValidator)
    .attach.SpendingValidator(paymentHookValidator)
    .attach.WithdrawalValidator(coordinatorValidator)
    .withdraw(state.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer)
    .pay.ToContract(
      state.pair.pairValidatorAddress,
      { kind: "inline", value: nextPairDatumCbor },
      {
        lovelace: BigInt(nextPairState.minUtxoLovelace),
        [state.pair.pairUnit]: 1n,
      },
    )
    .pay.ToContract(
      state.scripts.paymentHookValidatorAddress!,
      { kind: "inline", value: nextPaymentHookDatumCbor },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [state.scripts.paymentHookUnit!]: 1n,
      },
    );

  const txSignBuilder = await txBuilder.complete();
  const unsignedHash = txSignBuilder.toHash();
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await lucid.awaitTx(submittedTxHash, 3_000);
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }
  }

  const latestPairUtxo =
    args.buildOnly || !confirmed
      ? state.pair.stateUtxo
      : await findSingleUtxoAtUnit(
          lucid,
          state.pair.pairValidatorAddress,
          state.pair.pairUnit,
          "pair",
        );
  const latestPaymentHookUtxo =
    args.buildOnly || !confirmed
      ? state.paymentHookUtxo.current
      : await findSingleUtxoAtUnit(
          lucid,
          state.scripts.paymentHookValidatorAddress!,
          state.scripts.paymentHookUnit!,
          "payment hook",
        );

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: state.bootstrapRefs,
    scripts: state.scripts,
    configState: state.configState,
    configUtxo: {
      current: {
        txHash: currentConfigUtxo.txHash,
        outputIndex: currentConfigUtxo.outputIndex,
      },
    },
    paymentHookState: nextPaymentHookState,
    paymentHookUtxo: {
      current: {
        txHash: latestPaymentHookUtxo.txHash,
        outputIndex: latestPaymentHookUtxo.outputIndex,
      },
    },
    pair: {
      ...state.pair,
      stateUtxo: {
        txHash: latestPairUtxo.txHash,
        outputIndex: latestPairUtxo.outputIndex,
      },
    },
    pairState: nextPairState,
    datum: {
      configCbor: state.datum.configCbor,
      paymentHookCbor: nextPaymentHookDatumCbor,
      pairCbor: nextPairDatumCbor,
    },
    transaction: {
      submittedTxHash,
      confirmed,
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:update] ${message}`);
}

async function readUpdateInput(inputPath: string): Promise<UpdateInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as UpdateInput;
}

function buildPairDatumCbor(state: PairStateArtifact["pairState"]): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      state.pairId,
      BigInt(state.price),
      BigInt(state.timestamp),
      BigInt(state.nonce),
      normalizeHex(state.intentHash, "intentHash"),
      normalizeHex(state.signer, "signer"),
      BigInt(state.minUtxoLovelace),
    ]),
  );
}

function buildPaymentHookDatumCbor(
  state: PairStateArtifact["paymentHookState"],
): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      addressToPlutusData(state.withdrawAddress),
      BigInt(state.protocolFeePerTxLovelace),
      BigInt(state.minUtxoLovelace),
      BigInt(state.accruedFeesLovelace),
      BigInt(state.lifetimeFeesCollectedLovelace),
      BigInt(state.lifetimeFeesWithdrawnLovelace),
      BigInt(state.feeChargeCount),
    ]),
  );
}

function addressToPlutusData(address: string): Constr<PlutusData> {
  const details = getAddressDetails(address);
  if (!details.paymentCredential) {
    throw new Error("withdrawAddress must contain a payment credential.");
  }

  const paymentCredential =
    details.paymentCredential.type === "Key"
      ? new Constr<PlutusData>(0, [details.paymentCredential.hash])
      : new Constr<PlutusData>(1, [details.paymentCredential.hash]);

  const stakeCredential = details.stakeCredential
    ? new Constr<PlutusData>(0, [
        new Constr<PlutusData>(0, [
          details.stakeCredential.type === "Key"
            ? new Constr<PlutusData>(0, [details.stakeCredential.hash])
            : new Constr<PlutusData>(1, [details.stakeCredential.hash]),
        ]),
      ])
    : new Constr<PlutusData>(1, []);

  return new Constr<PlutusData>(0, [paymentCredential, stakeCredential]);
}

function updateWitnessData(
  intent: DiaOracleIntent,
  pairTokenName: string,
  signerPublicKey: string,
): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    pairTokenName,
    diaIntentData(intent),
    normalizeHex(signerPublicKey, "signerPublicKey"),
  ]);
}

function diaIntentData(intent: DiaOracleIntent): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    Buffer.from(intent.intentType, "utf8").toString("hex"),
    Buffer.from(intent.version, "utf8").toString("hex"),
    intent.chainId,
    intent.nonce,
    intent.expiry,
    Buffer.from(intent.symbol, "utf8").toString("hex"),
    intent.price,
    intent.timestamp,
    Buffer.from(intent.source, "utf8").toString("hex"),
    normalizeHex(intent.signature, "intent.signature"),
    normalizeHex(intent.signer, "intent.signer"),
  ]);
}

async function findSingleUtxoAtUnit(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
  label: string,
): Promise<UTxO> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const utxos = await lucid.utxosAtWithUnit(address, unit);
    if (utxos.length === 1) {
      return utxos[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(`Unable to observe a single ${label} UTxO at ${address} with unit ${unit}.`);
}

function splitUnit(unit: string): { policyId: string; assetName: string } {
  const normalizedUnit = normalizeHex(unit, "unit");
  return {
    policyId: normalizedUnit.slice(0, 56),
    assetName: normalizedUnit.slice(56),
  };
}

function selectFundingUtxo(
  utxos: UTxO[],
  excludedOutRefs: Array<{
    txHash: string;
    outputIndex: number;
  }>,
): UTxO | null {
  return (
    utxos
      .filter(
        (utxo) =>
          !excludedOutRefs.some(
            (outRef) =>
              utxo.txHash === outRef.txHash && utxo.outputIndex === outRef.outputIndex,
          ),
      )
      .filter((utxo) => Object.keys(utxo.assets).length === 1)
      .sort((left, right) => {
        const leftValue = left.assets.lovelace ?? 0n;
        const rightValue = right.assets.lovelace ?? 0n;
        if (leftValue === rightValue) return 0;
        return leftValue > rightValue ? -1 : 1;
      })[0] ?? null
  );
}
