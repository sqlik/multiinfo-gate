import type { StartupReason } from './reason.ts';

/** Uruchomiona bramka: w pracy normalnej albo w trybie awaryjnym, gdy nie mogła rozpocząć pracy. */
export interface RunningGate {
  apiPort: number;
  adminPort: number;
  apiHost: string;
  adminHost: string;
  mode: 'normal' | 'emergency';
  /** Przyczyna trybu awaryjnego; w pracy normalnej brak. */
  reason?: StartupReason;
  stop: () => Promise<void>;
}
