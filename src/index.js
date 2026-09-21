import { writeFileSync } from "fs";
import loadConfig from "./loadConfig.js";
import NotifyClient from "./notify.js";
import OverseerrClient from "./OverseerrClient.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Liveness heartbeat for the container healthcheck: written at the top of every poll iteration so a
// wedged loop goes stale. The compose healthcheck asserts this file's freshness (find -mmin -2).
const HEARTBEAT_FILE = "/tmp/approverr.heartbeat";

// The poll loop failing is one condition, not a stream of messages: the gateway keys it and edits a single
// card until a successful poll resolves it. The throttle keeps a tight retry loop from republishing the
// same firing state every five seconds.
const ERROR_CONDITION_KEY = "approverr:error";
const ERROR_THROTTLE_MS = 300000;

const errorCondition = { firing: false, lastPublishedAt: 0 };

function publishLoopError(notify, error) {
  if (Date.now() - errorCondition.lastPublishedAt <= ERROR_THROTTLE_MS) return;

  notify.publish({
    area: "media",
    severity: "warn",
    title: "approverr poll loop failing",
    // The body can reach a chat, so it stays a fixed phrase. The error text goes to `detail`, which the
    // gateway stores for its LAN-only history page and never sends on.
    body: "Approverr's poll loop has errored within the past five minutes. Check the container logs.",
    detail: String(error?.stack ?? error),
    key: ERROR_CONDITION_KEY,
    state: "firing",
  });

  errorCondition.firing = true;
  errorCondition.lastPublishedAt = Date.now();
}

function publishLoopRecovered(notify) {
  if (!errorCondition.firing) return;

  errorCondition.firing = false;
  errorCondition.lastPublishedAt = 0;

  notify.publish({
    area: "media",
    severity: "info",
    title: "approverr poll loop recovered",
    body: "Approverr is polling Seerr again.",
    key: ERROR_CONDITION_KEY,
    state: "resolved",
  });
}

const main = async function(config, notify) {
  const overseerrClient = new OverseerrClient(config.overseerr);
  const rules = config.rules;

  while (true) {
    writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    const requests = await overseerrClient.getRequests();
    publishLoopRecovered(notify);

    for (const request of requests) {
      let actionsToTake = false;
      let mediaDetails = request.type === 'movie' ? await overseerrClient.getMovieDetails(request.media.tmdbId) : await overseerrClient.getTVDetails(request.media.tmdbId);

      for (const rule of rules) {
        if (rule.type === 'movie' && request.type === 'movie') {
          if (rule.keywords) {
            for (const keyword of rule.keywords) {
              if (mediaDetails.keywords?.some(requestKeyword => requestKeyword.name.toLowerCase() === keyword.toLowerCase())) {
                console.log(`Tag ${keyword} found in movie ${mediaDetails.title}`);
                actionsToTake = rule.actions;
              }
            }
          }

          if (rule.strings) {
            for (const string of rule.strings) {
              if (mediaDetails.overview?.toLowerCase().includes(string.toLowerCase())) {
                console.log(`String ${string} found in movie ${mediaDetails.title}`);
                actionsToTake = rule.actions;
              } else if (mediaDetails.title?.toLowerCase().includes(string.toLowerCase())) {
                console.log(`String ${string} found in movie ${mediaDetails.title}`);
                actionsToTake = rule.actions;
              }
            }
          }

          if (rule.regex) {
            for (const regex of rule.regex) {
              const regexObj = new RegExp(regex);

              if (mediaDetails.overview?.match(regexObj)) {
                console.log(`Regex ${regexObj} found in movie ${mediaDetails.title}`);
                actionsToTake = rule.actions;
              }

              if (mediaDetails.title?.match(regexObj)) {
                console.log(`Regex ${regexObj} found in movie ${mediaDetails.title}`);
                actionsToTake = rule.actions;
              }
            }
          }
        } else if (rule.type === 'tv' && request.type === 'tv') {
          if (rule.keywords) {
            for (const keyword of rule.keywords) {
              if (mediaDetails.keywords?.some(requestKeyword => requestKeyword.name.toLowerCase() === keyword.toLowerCase())) {
                console.log(`Tag ${keyword} found in TV show ${mediaDetails.name}`);
                actionsToTake = rule.actions;
              }
            }
          }

          if (rule.strings) {
            for (const string of rule.strings) {
              if (mediaDetails.overview?.toLowerCase().includes(string.toLowerCase())) {
                console.log(`String ${string} found in TV show ${mediaDetails.name}`);
                actionsToTake = rule.actions;
              } else if (mediaDetails.name?.toLowerCase().includes(string.toLowerCase())) {
                console.log(`String ${string} found in TV show ${mediaDetails.name}`);
                actionsToTake = rule.actions;
              }
            }
          }

          if (rule.regex) {
            for (const regex of rule.regex) {
              if (mediaDetails.overview?.match(regex)) {
                console.log(`Regex ${regex} found in TV show ${mediaDetails.name}`);
                actionsToTake = rule.actions;
              }

              if (mediaDetails.name?.match(regex)) {
                console.log(`Regex ${regex} found in TV show ${mediaDetails.name}`);
                actionsToTake = rule.actions;
              }
            }
          }
        }
      }

      if (actionsToTake) {
        // We just support updating the root folder for now
        if (actionsToTake.rootFolder) {
          const options = {
            mediaType: request.type,
            rootFolder: actionsToTake.rootFolder
          }

          // Optionally pin the quality profile too, so a rule can keep its matches on a specific
          // profile regardless of the Overseerr/Seerr server default (e.g. keep wrestling on the
          // permissive "Any" profile even after the default is switched to a strict TRaSH profile).
          if (actionsToTake.profileId) {
            options.profileId = actionsToTake.profileId;
          }

          if (request.type === "tv") {
            options.seasons = request.seasons.map(season => season.seasonNumber);
          }

          await overseerrClient.updateRequest(request.id, options);
        }
      }

      if (config.autoApprove) {
        await overseerrClient.updateRequestStatus(request.id, 'approve');
      }

      // Routine chatter: one silent card per request. Fire-and-forget on purpose, so a slow or dead
      // gateway can never delay or fail an approval.
      const mediaTitle = request.type === 'movie' ? mediaDetails.title : mediaDetails.name;
      const verb = config.autoApprove ? 'approved' : 'received';

      notify.publish({
        area: 'media',
        severity: 'info',
        title: `Seerr request ${verb}: ${mediaTitle}`,
        body: actionsToTake
          ? `Request ${request.id} by ${request.requestedBy.displayName}, moved to ${actionsToTake.rootFolder}`
          : `Request ${request.id} by ${request.requestedBy.displayName}`,
        // A request leaves the pending filter once it is approved, so one key per request id is a safe
        // dedupe across a restart or a retried send.
        idempotencyKey: `approverr:request:${request.id}`,
      });
    }

    await sleep(30000);
  }
};


(async () => {
  let parsedConfig;

  try {
    parsedConfig = loadConfig();
  } catch (e) {
    console.error('Error loading config:');
    console.error(e);
    process.exit(1);
  }

  // The gateway URL and token come from the environment, never from config/config.yml: that file is
  // mounted from the deploy directory and lives next to a tracked example in a public repo.
  const notify = new NotifyClient();

  if (!notify.enabled) {
    console.warn('NOTIFY_URL or NOTIFY_TOKEN is not set: approverr is running without notifications.');
  }

  while (true) {
    try {
      await main(parsedConfig, notify);
    } catch (e) {
      console.error('Error running main loop:');
      console.error(e);

      publishLoopError(notify, e);

      await sleep(5000);
    }
  }
})();
