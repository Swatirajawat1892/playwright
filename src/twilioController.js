/**
 * Twilio inbound SMS webhook: extract 6-digit OTP and persist for Temporal poll.
 */
import express from "express";
import twilio from "twilio";
import {
  extractOtpFromText,
  getActiveAvailityWorkflowId,
  storeOtpForWorkflow,
} from "./otpStore.js";

const router = express.Router();

const urlEncoded = express.urlencoded({ extended: false });
const jsonBody = express.json();

/**
 * Twilio uses x-www-form-urlencoded; JSON accepted for local/integration tests.
 */
function twilioBodyParser(req, res, next) {
  const ct = req.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return jsonBody(req, res, next);
  }
  return urlEncoded(req, res, next);
}

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function publicUrl(req) {
  const base = process.env.PUBLIC_WEBHOOK_BASE_URL?.trim().replace(/\/$/, "");
  if (base) {
    return `${base}${req.originalUrl}`;
  }
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return `${proto}://${host}${req.originalUrl}`;
}

router.post("/twilio", twilioBodyParser, async (req, res) => {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    const signature = req.get("x-twilio-signature") ?? "";
    if (authToken && signature) {
      const valid = twilio.validateRequest(authToken, signature, publicUrl(req), req.body);
      if (!valid) {
        res.status(403).send("Invalid Twilio signature");
        return;
      }
    }

    const bodyText =
      typeof req.body?.Body === "string"
        ? req.body.Body
        : typeof req.body?.body === "string"
          ? req.body.body
          : "";

    const from =
      typeof req.body?.From === "string"
        ? req.body.From
        : typeof req.body?.from === "string"
          ? req.body.from
          : "";

    const workflowIdQuery =
      typeof req.query?.workflowId === "string" ? req.query.workflowId.trim() : "";

    const otp = extractOtpFromText(bodyText);
    if (!otp) {
      res.status(400).type("text/plain").send("No 6-digit code in message");
      return;
    }

    let workflowId = workflowIdQuery || null;
    if (!workflowId) {
      workflowId = await getActiveAvailityWorkflowId();
    }

    const expectedFrom = process.env.LINKEDIN_OTP_FROM?.trim();
    if (expectedFrom && from && from.replace(/\s/g, "") !== expectedFrom.replace(/\s/g, "")) {
      res.status(403).type("text/plain").send("From number not allowed");
      return;
    }

    if (!workflowId) {
      res.status(409).type("text/plain").send("No active workflow; call POST /start-login first or pass ?workflowId=");
      return;
    }

    await storeOtpForWorkflow(workflowId, otp);

    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Twilio webhook error:", message);
    res.status(500).type("text/plain").send("Server error");
  }
});

export { router as twilioWebhookRouter };
