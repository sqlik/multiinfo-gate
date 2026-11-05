// Stan serwera przekierowań krótkich linków. Błąd nasłuchu tego serwera, na przykład zajęty port,
// nie zatrzymuje bramki: API, panel, wysyłka i odbiór działają, skracanie jest wstrzymane,
// a panel pokazuje przyczynę.

/** Nieudany nasłuch serwera przekierowań: adres, port i kod błędu systemu, na przykład EADDRINUSE. */
export interface LinksServerProblem { host: string; port: number; code: string }

export class LinksServerState {
  private failure: LinksServerProblem | null = null;

  /** Prawda, dopóki nasłuch serwera przekierowań nie zakończył się błędem. */
  available(): boolean {
    return this.failure === null;
  }

  problem(): LinksServerProblem | null {
    return this.failure;
  }

  failed(problem: LinksServerProblem): void {
    this.failure = problem;
  }
}
