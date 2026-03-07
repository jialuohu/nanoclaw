export interface ScanResult {
  isSuspicious: boolean;
  warnings: string[];
}

const SUSPICIOUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i,
    label: 'instruction override attempt',
  },
  {
    pattern: /you\s+are\s+(now|actually)\s+/i,
    label: 'role reassignment attempt',
  },
  { pattern: /new\s+instructions?:/i, label: 'instruction injection' },
  { pattern: /system\s*prompt/i, label: 'system prompt reference' },
  {
    pattern: /forward\s+(all|every|my)\s+(email|message)/i,
    label: 'email forwarding request',
  },
  {
    pattern:
      /send\s+(?:(?:all|every|my)\s+)*(?:email|message|data|credentials)/i,
    label: 'data exfiltration attempt',
  },
  {
    pattern: /mcp__|send_message|schedule_task|register_group/i,
    label: 'tool invocation attempt',
  },
  {
    pattern:
      /<\/?(?:system|user|assistant|message|internal|messages)[\s>]/i,
    label: 'XML tag injection attempt',
  },
  { pattern: /CLAUDE\.md|\.claude\//i, label: 'config file reference' },
];

export function scanEmailContent(body: string, subject: string): ScanResult {
  const warnings: string[] = [];
  const combined = `${subject}\n${body}`;

  for (const { pattern, label } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(combined)) {
      warnings.push(label);
    }
  }

  return {
    isSuspicious: warnings.length > 0,
    warnings,
  };
}
