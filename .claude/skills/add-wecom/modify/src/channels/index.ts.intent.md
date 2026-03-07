# Intent: Add WeCom channel import

Add `import './wecom.js';` to the channel barrel file so the WeCom module
self-registers with the channel registry on startup.

This is an append-only change -- existing import lines for other channels
must be preserved. The import should appear alphabetically between telegram
and whatsapp comments.
