// src/instrument.ts

import * as dotenv from "dotenv";
dotenv.config();

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

// Make sure to call this before requiring any other modules!
const SENTRY_DSN = process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    integrations: [nodeProfilingIntegration()],
    // Tracing
    tracesSampleRate: 1.0, //  Capture 100% of the transactions
    // Set sampling rate for profiling - this is evaluated only once per SDK.init call
    profileSessionSampleRate: 1.0,
    // Trace lifecycle automatically enables profiling during active traces
    profileLifecycle: "trace",

    // Send structured logs to Sentry
    enableLogs: true,

    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,

    // Add debug mode to see what's happening
    debug: process.env.NODE_ENV === "development",

    // Add beforeSend hook to log when errors are being sent
    beforeSend(event, hint) {
      return event;
    },

    // Add beforeSendTransaction hook
    beforeSendTransaction(event) {
      return event;
    },
  });

  // Add breadcrumb
  Sentry.addBreadcrumb({
    message: "Sentry initialization completed",
    level: "info",
  });

  // Example of starting a custom span. This is optional.
  Sentry.startSpan(
    {
      name: "Server startup",
    },
    () => {
      // The code executed here will be profiled
    },
  );
} else {
  console.warn("SENTRY_DSN is not set. Sentry will not be initialized.");
  console.warn(
    "Available env vars starting with SENTRY:",
    Object.keys(process.env).filter((key) => key.startsWith("SENTRY")),
  );
}
