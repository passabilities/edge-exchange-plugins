// @flow

import { lt, mul } from 'biggystring'
import {
  type Cleaner,
  asArray,
  asDate,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeSwapInfo,
  type EdgeSwapPlugin,
  type EdgeSwapQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapAboveLimitError,
  SwapBelowLimitError,
  SwapCurrencyError
} from 'edge-core-js/types'

import { makeSwapPluginQuote } from '../swap-helpers.js'

const pluginId = 'changenow'
const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'Change NOW',

  quoteUri: 'https://changenow.io/exchange/txs/',
  supportEmail: 'support@changenow.io'
}

const uri = 'https://changenow.io/api/v1/'

const dontUseLegacy = {
  DGB: true
}

const CURRENCY_CODE_TRANSCRIPTION = {
  USDT: 'USDTERC20'
}

// Invalid currency codes should *not* have transcribed codes
// because currency codes with transcribed versions are NOT invalid
const INVALID_CURRENCY_CODES = {
  // edgeCurrenvyCode: exchangeCurrencyCode
}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

export function makeChangeNowPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { initOptions, io, log } = opts
  const { fetch } = io

  if (initOptions.apiKey == null) {
    throw new Error('No ChangeNow apiKey provided.')
  }
  const { apiKey } = initOptions

  async function get(route: string) {
    const response = await fetch(uri + route)
    return response.json()
  }

  async function post(route: string, body: any) {
    log('call fixed:', route, body)

    const response = await fetch(uri + route, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
    if (!response.ok) {
      throw new Error(`ChangeNow call returned error code ${response.status}`)
    }
    const out = await response.json()
    log('fixed reply:', out)
    return out
  }

  const out: EdgeSwapPlugin = {
    swapInfo,

    async fetchSwapQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void,
      opts: { promoCode?: string }
    ): Promise<EdgeSwapQuote> {
      const { promoCode } = opts

      if (
        // if either currencyCode is invalid *and* doesn't have a transcription
        INVALID_CURRENCY_CODES[request.fromCurrencyCode] ||
        INVALID_CURRENCY_CODES[request.toCurrencyCode]
      ) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }
      // Grab addresses:
      const [fromAddress, toAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])

      // transcribe currencyCodes if necessary
      let safeFromCurrencyCode = request.fromCurrencyCode
      let safeToCurrencyCode = request.toCurrencyCode
      if (CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]) {
        safeFromCurrencyCode =
          CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]
      }
      if (CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]) {
        safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]
      }

      // get the markets
      const availablePairs = await get(`currencies-to/${safeFromCurrencyCode}`)
      const fixedMarket = asFixedMarketReply(
        await get(
          `market-info/fixed-rate/${apiKey}` +
            (promoCode != null ? `?promo=${promoCode}` : '')
        )
      )

      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )

      // Swap the currencies if we need a reverse quote:
      const quoteParams =
        request.quoteFor === 'from'
          ? {
              from: safeFromCurrencyCode.toLowerCase(),
              to: safeToCurrencyCode.toLowerCase(),
              amount: quoteAmount
            }
          : {
              from: safeToCurrencyCode.toLowerCase(),
              to: safeFromCurrencyCode.toLowerCase(),
              amount: quoteAmount
            }

      const pairsToUse = []
      let fromAmount, fromNativeAmount, toNativeAmount
      let pairItem
      let quoteReplyKeep = { estimatedAmount: '0' }
      for (let i = 0; i < availablePairs.length; i++) {
        const obj = availablePairs[i]
        if (safeToCurrencyCode.toLowerCase() === obj.ticker) {
          pairsToUse.push(obj)
          if (obj.supportsFixedRate) {
            for (let j = 0; j < fixedMarket.length; j++) {
              const item = fixedMarket[j]
              if (
                item.from === quoteParams.from &&
                item.to === quoteParams.to
              ) {
                pairItem = item
                const [nativeMax, nativeMin] = await Promise.all([
                  request.fromWallet.denominationToNative(
                    item.max.toString(),
                    request.fromCurrencyCode
                  ),
                  request.fromWallet.denominationToNative(
                    item.min.toString(),
                    request.fromCurrencyCode
                  )
                ])
                // lets get the quoteObject here
                const quoteReply = await get(
                  `exchange-amount/fixed-rate/${quoteParams.amount}/${quoteParams.from}_${quoteParams.to}?api_key=${apiKey}` +
                    (promoCode != null ? `&promo=${promoCode}` : '')
                )
                if (quoteReply.error === 'out_of_range') {
                  if (lt(quoteParams.amount, item.min.toString())) {
                    throw new SwapBelowLimitError(swapInfo, nativeMin)
                  } else {
                    throw new SwapAboveLimitError(swapInfo, nativeMax)
                  }
                }
                if (quoteReply.error) {
                  throw new SwapCurrencyError(
                    swapInfo,
                    request.fromCurrencyCode,
                    request.toCurrencyCode
                  )
                }
                quoteReplyKeep = quoteReply
              }
            }
            if (pairItem) {
              if (request.quoteFor === 'from') {
                fromAmount = quoteAmount
                fromNativeAmount = request.nativeAmount
                toNativeAmount = await request.toWallet.denominationToNative(
                  quoteReplyKeep.estimatedAmount.toString(),
                  request.toCurrencyCode
                )
              } else {
                fromAmount = mul(
                  quoteReplyKeep.estimatedAmount.toString(),
                  '1.02'
                )
                fromNativeAmount = await request.fromWallet.denominationToNative(
                  fromAmount,
                  request.fromCurrencyCode
                )
                toNativeAmount = request.nativeAmount
              }
              const sendReply = asCreateOrderReply(
                await post(`transactions/fixed-rate/${apiKey}`, {
                  amount: fromAmount,
                  from: safeFromCurrencyCode,
                  to: safeToCurrencyCode,
                  address: toAddress,
                  extraId: null, // TODO: Do we need this for Monero?
                  refundAddress: fromAddress,
                  payload: { promoCode }
                })
              )
              log('Fixed sendReply q ', sendReply)
              const spendInfo = {
                currencyCode: request.fromCurrencyCode,
                spendTargets: [
                  {
                    nativeAmount: fromNativeAmount,
                    publicAddress: sendReply.payinAddress,
                    otherParams: {
                      uniqueIdentifier: sendReply.payinExtraId
                    }
                  }
                ]
              }
              log('spendInfo', spendInfo)
              const tx: EdgeTransaction = await request.fromWallet.makeSpend(
                spendInfo
              )
              if (tx.otherParams == null) tx.otherParams = {}
              tx.otherParams.payinAddress =
                spendInfo.spendTargets[0].publicAddress
              tx.otherParams.uniqueIdentifier =
                spendInfo.spendTargets[0].otherParams.uniqueIdentifier
              const toAmount = await request.toWallet.denominationToNative(
                sendReply.amount.toString(),
                request.toCurrencyCode
              )
              return makeSwapPluginQuote(
                request,
                fromNativeAmount,
                toAmount,
                tx,
                toAddress,
                pluginId,
                false,
                sendReply.validUntil,
                sendReply.id
              )
            }
          }
        }
      }
      if (pairsToUse.length === 0) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }

      const min = await get(`min-amount/${quoteParams.from}_${quoteParams.to}`)
      if (min.minAmount == null) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }
      const [nativeMin] = await Promise.all([
        request.fromWallet.denominationToNative(
          min.minAmount.toString(),
          request.fromCurrencyCode
        )
      ])

      const quoteReply = await get(
        `exchange-amount/${quoteParams.amount}/${quoteParams.from}_${quoteParams.to}`
      )
      if (quoteReply.error) {
        log('reply error ', quoteReply.error)
        if (quoteReply.error === 'deposit_too_small') {
          throw new SwapBelowLimitError(swapInfo, nativeMin)
        }
      }
      log('got reply  ', quoteReply)
      if (request.quoteFor === 'from') {
        fromAmount = quoteAmount
        fromNativeAmount = request.nativeAmount
        toNativeAmount = await request.toWallet.denominationToNative(
          quoteReply.estimatedAmount.toString(),
          request.toCurrencyCode
        )
      } else {
        fromAmount = mul(quoteReply.estimatedAmount.toString(), '1.02')
        fromNativeAmount = await request.fromWallet.denominationToNative(
          fromAmount,
          request.fromCurrencyCode
        )
        toNativeAmount = request.nativeAmount
      }
      log('estQuery quoteReply  ', quoteReply)

      if (lt(fromNativeAmount, nativeMin)) {
        throw new SwapBelowLimitError(swapInfo, nativeMin)
      }

      const sendReply = asCreateOrderReply(
        await post(`transactions/${apiKey}`, {
          amount: fromAmount,
          from: safeFromCurrencyCode.toLowerCase(),
          to: safeToCurrencyCode.toLowerCase(),
          address: toAddress,
          extraId: null, // TODO: Do we need this for Monero?
          refundAddress: fromAddress,
          payload: { promoCode }
        })
      )

      // Make the transaction:
      const spendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: fromNativeAmount,
            publicAddress: sendReply.payinAddress,
            otherParams: {
              uniqueIdentifier: sendReply.payinExtraId
            }
          }
        ]
      }
      log('spendInfo', spendInfo)
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)
      if (tx.otherParams == null) tx.otherParams = {}
      tx.otherParams.payinAddress = spendInfo.spendTargets[0].publicAddress
      tx.otherParams.uniqueIdentifier =
        spendInfo.spendTargets[0].otherParams.uniqueIdentifier

      return makeSwapPluginQuote(
        request,
        fromNativeAmount,
        toNativeAmount,
        tx,
        toAddress,
        pluginId,
        true,
        new Date(Date.now() + 1000 * 60 * 20)
      )
    }
  }

  return out
}

/**
 * An optional value, where a blank string means undefined.
 */
export function asOptionalBlank<T>(
  cleaner: (raw: any) => T
): Cleaner<T | void> {
  return function asIgnoredBlank(raw) {
    if (raw == null || raw === '') return
    return cleaner(raw)
  }
}

const asFixedMarketReply = asArray(
  asObject({
    from: asString,
    to: asString,
    min: asNumber,
    max: asNumber,
    rate: asNumber,
    minerFee: asNumber
  })
)

const asCreateOrderReply = asObject({
  amount: asNumber,
  fromCurrency: asString,
  toCurrency: asString,
  id: asString,
  payinAddress: asString,
  payinExtraId: asOptionalBlank(asString),
  payoutAddress: asOptionalBlank(asString),
  payoutExtraId: asOptionalBlank(asString),
  refundAddress: asOptionalBlank(asString),
  refundExtraId: asOptionalBlank(asString),
  validUntil: asOptional(asDate)
})
