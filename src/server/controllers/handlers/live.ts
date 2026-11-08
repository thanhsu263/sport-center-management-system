import type { Sql } from "@/lib/db";
import type { PublicUser } from "../session";
import { one } from "../tx";

/**
 * Reads a cheap "version" string for a topic.
 * Returns a timestamp string or a compact hash/state string.
 */
async function getTopicVersion(sql: Sql, topic: string, user: PublicUser | null): Promise<string> {
  try {
    if (topic === "courts") {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from audit_logs where entity in ('court', 'booking', 'hold', 'occupancy')), '1970-01-01'::timestamptz),
          coalesce((select max(created_at) from court_bookings), '1970-01-01'::timestamptz),
          coalesce((select max(start_at) from occupancies), '1970-01-01'::timestamptz)
        )::text as v`,
      );
      return row?.v ?? "0";
    }

    if (topic === "classes") {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from audit_logs where entity in ('class', 'enrollment', 'session', 'attendance')), '1970-01-01'::timestamptz),
          coalesce((select max(start_at) from sessions), '1970-01-01'::timestamptz)
        )::text as v`,
      );
      return row?.v ?? "0";
    }

    if (topic.startsWith("class:")) {
      const classId = topic.slice(6);
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from audit_logs where entity = 'class' and entity_id::text = $1), '1970-01-01'::timestamptz),
          coalesce((select max(at) from audit_logs where entity in ('enrollment', 'session') and (before->>'class_id' = $1 or after->>'class_id' = $1)), '1970-01-01'::timestamptz),
          coalesce((select max(start_at) from sessions where class_id::text = $1), '1970-01-01'::timestamptz)
        )::text as v`,
        [classId],
      );
      return row?.v ?? "0";
    }

    if (topic === "notifications" && user) {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(created_at) from outbox where user_id = $1 and channel = 'inapp'), '1970-01-01'::timestamptz),
          coalesce((select max(at) from audit_logs where actor_id = $1 and action like '%notification%'), '1970-01-01'::timestamptz)
        )::text as v`,
        [user.id],
      );
      return row?.v ?? "0";
    }

    if (topic.startsWith("payment:")) {
      const paymentId = topic.slice(8);
      const row = await one<{ v: string }>(
        sql,
        `select coalesce(status, 'unknown')::text as v from payments where id::text = $1 or ref_id::text = $1 limit 1`,
        [paymentId],
      );
      return row?.v ?? "0";
    }

    if (topic === "attendance" || topic.startsWith("attendance:")) {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from attendance), '1970-01-01'::timestamptz),
          coalesce((select max(at) from audit_logs where entity = 'attendance'), '1970-01-01'::timestamptz)
        )::text as v`,
      );
      return row?.v ?? "0";
    }

    if (topic.startsWith("chat:")) {
      const convId = topic.slice(5);
      const row = await one<{ v: string }>(
        sql,
        `select coalesce(max(created_at), '1970-01-01'::timestamptz)::text as v from messages where conversation_id::text = $1`,
        [convId],
      ).catch(() => ({ v: "0" }));
      return row?.v ?? "0";
    }
  } catch {
    // If table does not exist or query fails, return default version
  }
  return "0";
}

/**
 * Filter topics to only those the requester is permitted to see.
 */
function filterAllowedTopics(topics: string[], user: PublicUser | null): string[] {
  return topics.filter((t) => {
    if (t === "courts" || t === "classes" || t.startsWith("class:") || t.startsWith("payment:")) {
      return true;
    }
    if (t === "notifications") {
      return !!user;
    }
    if (t === "attendance" || t.startsWith("attendance:")) {
      // Attendance is visible to staff (coach, receptionist, manager) or authenticated users
      return !!user;
    }
    if (t.startsWith("chat:")) {
      return !!user;
    }
    return false;
  });
}

/**
 * Server-Sent Events handler for /api/live?topics=...
 */
export async function liveStreamHandler(request: Request, sql: Sql, user: PublicUser | null): Promise<Response> {
  const url = new URL(request.url);
  const requestedTopics = (url.searchParams.get("topics") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const allowedTopics = filterAllowedTopics(requestedTopics, user);

  // Maximum lifetime for a single serverless stream (25 seconds) before clean close
  const MAX_STREAM_MS = 25_000;
  const POLL_INTERVAL_MS = 2_000;
  const HEARTBEAT_INTERVAL_MS = 10_000;

  let streamEnded = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        if (streamEnded) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          streamEnded = true;
        }
      };

      // Initial connection greeting
      send(": connected\n\n");

      // Initial versions map
      const versions = new Map<string, string>();
      for (const t of allowedTopics) {
        const v = await getTopicVersion(sql, t, user);
        versions.set(t, v);
      }

      const startTime = Date.now();
      let lastHeartbeat = Date.now();

      const loop = async () => {
        if (streamEnded || request.signal.aborted) {
          streamEnded = true;
          try {
            controller.close();
          } catch {}
          return;
        }

        // Close cleanly before Vercel timeout so EventSource reconnects gracefully
        if (Date.now() - startTime >= MAX_STREAM_MS) {
          send(": timeout-reconnect\n\n");
          streamEnded = true;
          try {
            controller.close();
          } catch {}
          return;
        }

        // Check for version changes
        for (const t of allowedTopics) {
          if (streamEnded) break;
          const current = await getTopicVersion(sql, t, user);
          const previous = versions.get(t);
          if (current !== previous) {
            versions.set(t, current);
            send(`data: ${JSON.stringify({ topic: t, version: current })}\n\n`);
          }
        }

        // Heartbeat
        if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          send(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }

        if (!streamEnded && !request.signal.aborted) {
          setTimeout(() => void loop(), POLL_INTERVAL_MS);
        }
      };

      request.signal.addEventListener("abort", () => {
        streamEnded = true;
        try {
          controller.close();
        } catch {}
      });

      // Start polling loop
      setTimeout(() => void loop(), POLL_INTERVAL_MS);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
