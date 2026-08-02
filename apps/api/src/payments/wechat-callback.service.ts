import {
  parseWechatPayRefundNotice,
  parseWechatPayTransactionNotice,
  WechatPayProtocolError,
  type WechatPaySignatureHeaders,
  WechatPayV3Protocol,
} from "@campus/payments";
import { Inject, Injectable } from "@nestjs/common";
import { ApplicationError } from "../common/application-error";
import { APP_CONFIG, type AppConfig } from "../config";
import { PaymentsService } from "./payments.service";

@Injectable()
export class WechatCallbackService {
  private readonly protocol?: WechatPayV3Protocol;

  public constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    if (config.wechatPayCallbacks !== undefined) {
      this.protocol = new WechatPayV3Protocol(config.wechatPayCallbacks);
    }
  }

  /**
   * Receives the original UTF-8 body, verifies it before JSON processing, and
   * never logs or persists the ciphertext/plaintext. A 204 acknowledgement is
   * issued only after the event ledger has committed.
   */
  public async acceptTransactionSuccess(
    headers: WechatPaySignatureHeaders,
    rawBody: Buffer,
    now = new Date(),
  ): Promise<void> {
    const protocol = this.protocol;
    if (protocol === undefined) {
      throw new ApplicationError("RESOURCE_NOT_FOUND", "payment callback is not enabled", 404);
    }
    try {
      const notification = protocol.parseAndVerifyNotification(headers, decodeStrictUtf8(rawBody), {
        now,
      });
      if (notification.envelope.event_type !== "TRANSACTION.SUCCESS") {
        throw new ApplicationError("VALIDATION_ERROR", "unsupported payment callback event", 400);
      }
      const transaction = parseWechatPayTransactionNotice(notification.plaintext, {
        merchantId: protocol.merchantId,
        appId: protocol.appId,
      });
      if (transaction.tradeState !== "SUCCESS" || transaction.transactionId === undefined) {
        throw new ApplicationError("VALIDATION_ERROR", "payment callback is not successful", 400);
      }
      const occurredAt = new Date(transaction.successTime ?? notification.envelope.create_time);
      if (!Number.isFinite(occurredAt.getTime())) {
        throw new ApplicationError("VALIDATION_ERROR", "payment callback time is invalid", 400);
      }
      const receipt = await this.payments.ingestVerifiedWechatPaymentEvent({
        eventId: notification.envelope.id,
        eventType: "TRANSACTION.SUCCESS",
        verifierKeyId: headers.serial,
        rawDigest: notification.rawDigest,
        merchantOrderNo: transaction.merchantOrderNo,
        providerTransactionId: transaction.transactionId,
        amountFen: transaction.amountFen,
        currency: transaction.currency,
        occurredAt,
      });
      if (receipt.status === "RECEIVED") {
        await this.payments.applyVerifiedWechatPaymentEvent(receipt.providerEventId, now);
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof WechatPayProtocolError) {
        throw new ApplicationError(
          "RESOURCE_FORBIDDEN",
          "payment callback verification failed",
          403,
        );
      }
      throw error;
    }
  }

  public async acceptRefundSuccess(
    headers: WechatPaySignatureHeaders,
    rawBody: Buffer,
    now = new Date(),
  ): Promise<void> {
    const protocol = this.protocol;
    if (protocol === undefined) {
      throw new ApplicationError("RESOURCE_NOT_FOUND", "payment callback is not enabled", 404);
    }
    try {
      const notification = protocol.parseAndVerifyNotification(headers, decodeStrictUtf8(rawBody), {
        now,
      });
      if (notification.envelope.event_type !== "REFUND.SUCCESS") {
        throw new ApplicationError("VALIDATION_ERROR", "unsupported refund callback event", 400);
      }
      const refund = parseWechatPayRefundNotice(notification.plaintext);
      if (refund.status !== "SUCCESS" || refund.providerRefundId === undefined) {
        throw new ApplicationError("VALIDATION_ERROR", "refund callback is not successful", 400);
      }
      const occurredAt = new Date(refund.successTime ?? notification.envelope.create_time);
      if (!Number.isFinite(occurredAt.getTime())) {
        throw new ApplicationError("VALIDATION_ERROR", "refund callback time is invalid", 400);
      }
      const receipt = await this.payments.ingestVerifiedWechatRefundEvent({
        eventId: notification.envelope.id,
        eventType: "REFUND.SUCCESS",
        verifierKeyId: headers.serial,
        rawDigest: notification.rawDigest,
        merchantOrderNo: refund.merchantOrderNo,
        merchantRefundNo: refund.merchantRefundNo,
        providerRefundId: refund.providerRefundId,
        amountFen: refund.amountFen,
        currency: refund.currency,
        occurredAt,
      });
      if (receipt.status === "RECEIVED") {
        await this.payments.applyVerifiedWechatRefundEvent(receipt.providerEventId, now);
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof WechatPayProtocolError) {
        throw new ApplicationError(
          "RESOURCE_FORBIDDEN",
          "payment callback verification failed",
          403,
        );
      }
      throw error;
    }
  }
}

/**
 * The signature is over the provider's exact UTF-8 bytes. Node otherwise
 * replaces malformed sequences while decoding, which would make the verifier
 * operate on a different string than the bytes delivered to the callback.
 */
function decodeStrictUtf8(rawBody: Buffer): string {
  const decoded = rawBody.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(rawBody)) {
    throw new ApplicationError("VALIDATION_ERROR", "payment callback is not valid UTF-8", 400);
  }
  return decoded;
}
