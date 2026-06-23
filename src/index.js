import { writeFileSync } from "fs";
import loadConfig from "./loadConfig.js";
import OverseerrClient from "./OverseerrClient.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Liveness heartbeat for the container healthcheck: written at the top of every poll iteration so a
// wedged loop goes stale. The compose healthcheck asserts this file's freshness (find -mmin -2).
const HEARTBEAT_FILE = "/tmp/approverr.heartbeat";

const main = async function(config) {
  const overseerrClient = new OverseerrClient(config.overseerr);
  const rules = config.rules;

  while (true) {
    writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    const requests = await overseerrClient.getRequests();

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

      if (config.ntfy && config.ntfy.enabled) {
        // Do not send the actual error because ntfy is not a secure service, and the error could contain sensitive information

        let message;
        const mediaTitle = request.type === 'movie' ? mediaDetails.title : mediaDetails.name;

        if (actionsToTake) {
          message = `Request ${request.id} by user ${request.requestedBy.displayName} for title ${mediaTitle} ${config.autoApprove ? 'approved and ' : ' '}moved to ${actionsToTake.rootFolder}`;
        } else {
          message = `Request ${request.id} by user ${request.requestedBy.displayName} for title ${mediaTitle} ${config.autoApprove ? 'approved' : 'received'}`;
        }

        await fetch(`https://ntfy.sh/${config.ntfy.topic}`, {
          method: 'POST',
          body: message
        });
      }
    }

    await sleep(30000);
  }
};


(async () => {
  let parsedConfig;
  let timeLastNtfyErrorMessageSent = 0;

  try {
    parsedConfig = loadConfig();
  } catch (e) {
    console.error('Error loading config:');
    console.error(e);
    process.exit(1);
  }

  while (true) {
    try {
      await main(parsedConfig);
    } catch (e) {
      console.error('Error running main loop:');
      console.error(e);

      if (parsedConfig.ntfy && parsedConfig.ntfy.enabled) {
        if (Date.now() - timeLastNtfyErrorMessageSent > 300000) {

          try {
            await fetch(`https://ntfy.sh/${parsedConfig.ntfy.topic}`, {
              method: 'POST',
              body: 'Error in Approverr within the past five minutes. Please check logs for more information.'
            });
          } catch (error) {
            console.error('Error sending ntfy message to alert about an error:');
            console.error(error);
          }

          timeLastNtfyErrorMessageSent = Date.now();
        }
      }

      await sleep(5000);
    }
  }
})();
