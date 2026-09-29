// Generated from flagship.yml — do not edit directly.
// Edit flagship.yml then run: node build-profiles.js
'use strict';
module.exports = {
  "global": {
    "timeoutMs": 600000,
    "cooldownMs": 60000,
    "order": "newest"
  },
  "providers": {
    "xai": {
      "include": "^grok-",
      "exclude": "non-?reasoning|fast|mini|lite|code-fast|image|imagine|video",
      "fallback": "grok-4"
    },
    "anthropic": {
      "include": "^claude-",
      "exclude": "haiku|instant|mini",
      "fallback": "claude-sonnet-5"
    },
    "gemini": {
      "include": "gemini-",
      "exclude": "flash|lite|embedding|aqa|imagen|veo|tts|live|image|audio",
      "fallback": "gemini-flash-latest"
    },
    "openrouter": {
      "fallback": "openrouter/free"
    }
  }
};
