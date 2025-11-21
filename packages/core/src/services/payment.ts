import { Effect } from 'effect';
import { nanoid } from 'nanoid';
import type { Invoice, PaymentProof, QuoteRequest, Message } from '../types';
import { InvoiceExpiredError } from '../errors';

export namespace PaymentProtocol {
  export function createInvoice(
    jobId: string,
    chainId: number,
    amount: string,
    token: string,
    recipient: string,
    validUntil: number
  ): Invoice {
    return {
      id: nanoid(),
      jobId,
      chainId,
      amount,
      token,
      recipient,
      validUntil,
    };
  }

  export function validateInvoice(invoice: Invoice): Effect.Effect<boolean, InvoiceExpiredError> {
    return Effect.gen(function* () {
      const now = Date.now();
      if (now > invoice.validUntil) {
        return yield* Effect.fail(
          new InvoiceExpiredError({
            message: 'Invoice has expired',
            invoiceId: invoice.id,
            validUntil: invoice.validUntil,
            currentTime: now,
          })
        );
      }
      return true;
    });
  }

  export async function validateInvoiceAsync(invoice: Invoice): Promise<boolean> {
    try {
      return await Effect.runPromise(validateInvoice(invoice));
    } catch (error) {
      if (error instanceof InvoiceExpiredError) {
        throw error;
      }
      throw error;
    }
  }

  export function createQuoteRequest(
    jobType: string,
    jobParams: Record<string, unknown>,
    preferredChains?: number[]
  ): QuoteRequest {
    return {
      jobType,
      jobParams,
      preferredChains,
    };
  }

  export function createPaymentProof(
    invoiceId: string,
    txHash: string,
    chainId: number
  ): PaymentProof {
    return {
      invoiceId,
      txHash,
      chainId,
    };
  }

  export function createRequestQuoteMessage(
    from: string,
    to: string,
    quoteRequest: QuoteRequest
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'request-quote',
      payload: quoteRequest,
      timestamp: Date.now(),
    };
  }

  export function createInvoiceMessage(
    from: string,
    to: string,
    invoice: Invoice
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'invoice',
      payload: invoice,
      timestamp: Date.now(),
    };
  }

  export function createPaymentProofMessage(
    from: string,
    to: string,
    paymentProof: PaymentProof
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'submit-payment-proof',
      payload: paymentProof,
      timestamp: Date.now(),
    };
  }

  export function createPaymentVerifiedMessage(
    from: string,
    to: string,
    invoiceId: string
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'payment-verified',
      payload: { invoiceId },
      timestamp: Date.now(),
    };
  }

  export function createPaymentFailedMessage(
    from: string,
    to: string,
    invoiceId: string,
    reason: string
  ): Message {
    return {
      id: nanoid(),
      from,
      to,
      type: 'payment-failed',
      payload: { invoiceId, reason },
      timestamp: Date.now(),
    };
  }

  export function isRequestQuoteMessage(message: unknown): message is Message & { payload: QuoteRequest } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'request-quote' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'jobType' in msg.payload &&
      'jobParams' in msg.payload
    );
  }

  export function isInvoiceMessage(message: unknown): message is Message & { payload: Invoice } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'invoice' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'id' in msg.payload &&
      'jobId' in msg.payload &&
      'chainId' in msg.payload &&
      'amount' in msg.payload &&
      'token' in msg.payload &&
      'recipient' in msg.payload &&
      'validUntil' in msg.payload
    );
  }

  export function isPaymentProofMessage(message: unknown): message is Message & { payload: PaymentProof } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'submit-payment-proof' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'invoiceId' in msg.payload &&
      'txHash' in msg.payload &&
      'chainId' in msg.payload
    );
  }

  export function isPaymentVerifiedMessage(message: unknown): message is Message & { payload: { invoiceId: string } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'payment-verified' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'invoiceId' in msg.payload
    );
  }

  export function isPaymentFailedMessage(message: unknown): message is Message & { payload: { invoiceId: string; reason: string } } {
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const msg = message as Record<string, unknown>;
    return (
      msg.type === 'payment-failed' &&
      typeof msg.payload === 'object' &&
      msg.payload !== null &&
      'invoiceId' in msg.payload &&
      'reason' in msg.payload
    );
  }
}

