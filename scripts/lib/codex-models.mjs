export const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.4', label: 'Codex gpt-5.4', description: 'Codex balanced model' },
  { value: 'gpt-5.3', label: 'Codex gpt-5.3', description: 'Codex reasoning model' },
  { value: 'gpt-5.4-mini', label: 'Codex gpt-5.4-mini', description: 'Codex fast model' },
  { value: 'gpt-5.3-mini', label: 'Codex gpt-5.3-mini', description: 'Codex mini model' },
];

export const DEFAULT_CODEX_MODEL = CODEX_MODEL_OPTIONS[0].value;

export function getCodexModelLabel(value) {
  return CODEX_MODEL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
