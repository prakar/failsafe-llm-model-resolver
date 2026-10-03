// Generated from economy.yml — do not edit directly.
// Edit economy.yml then run: node build-profiles.js
'use strict';
module.exports = {
  "global": {
    "timeoutMs": 300000,
    "cooldownMs": 60000,
    "order": "cheapest"
  },
  "providers": {
    "xai": {
      "include": "^grok-",
      "exclude": "non-?reasoning|image|imagine|video|code-fast",
      "fallback": "grok-4.3"
    },
    "anthropic": {
      "include": "^claude-",
      "exclude": "instant|mini",
      "fallback": "claude-haiku-4-5",
      "knownPrices": {
        "source": "maintained",
        "updated": "2026-09-29",
        "models": {
          "claude-haiku-3": {
            "input": 0.25,
            "output": 1.25
          },
          "claude-haiku-4": {
            "input": 1,
            "output": 5
          },
          "claude-sonnet-4": {
            "input": 3,
            "output": 15
          },
          "claude-sonnet-5": {
            "input": 3,
            "output": 15
          },
          "claude-opus-4": {
            "input": 15,
            "output": 75
          },
          "claude-opus-5": {
            "input": 15,
            "output": 75
          }
        }
      }
    },
    "gemini": {
      "include": "gemini-",
      "exclude": "lite|embedding|aqa|imagen|veo|tts|live|image|audio",
      "fallback": "gemini-flash-latest",
      "knownPrices": {
        "source": "maintained",
        "updated": "2026-09-29",
        "models": {
          "gemini-flash-latest": {
            "input": 0.075,
            "output": 0.3
          },
          "gemini-2.5-flash": {
            "input": 0.075,
            "output": 0.3
          },
          "gemini-2.5-pro": {
            "input": 1.25,
            "output": 5
          },
          "gemini-3-pro": {
            "input": 1.25,
            "output": 5
          },
          "gemini-3.1-pro": {
            "input": 1.25,
            "output": 5
          },
          "gemini-pro-latest": {
            "input": 1.25,
            "output": 5
          }
        }
      }
    },
    "openrouter": {
      "fallback": "openrouter/free"
    }
  }
};
