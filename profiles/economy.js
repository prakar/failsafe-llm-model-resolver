// Generated from economy.yml — do not edit directly.
// Edit economy.yml then run: node build-profiles.js
'use strict';
module.exports = {
  "global": {
    "timeoutMs": 300000,
    "cooldownMs": 60000,
    "order": "newest"
  },
  "providers": {
    "xai": {
      "include": "^grok-",
      "exclude": "(?:^|[.-])reasoning|non-?reasoning|image|imagine|video|code-fast",
      "pin": "grok-4.3",
      "fallback": "grok-4.3"
    },
    "anthropic": {
      "include": "^claude-",
      "exclude": "instant|mini",
      "fallback": "claude-haiku-4-5"
    },
    "gemini": {
      "include": "gemini-",
      "exclude": "lite|embedding|aqa|imagen|veo|tts|live|image|audio",
      "fallback": "gemini-flash-latest"
    },
    "openrouter": {
      "fallback": "openrouter/free"
    }
  }
};
