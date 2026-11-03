/**
 * Circuit breaker mínimo (§10.3): tras `threshold` fallos consecutivos se abre
 * durante `openMs`; después deja pasar una prueba (semiabierto).
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold = 5,
    private readonly openMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.openMs ? 'half-open' : 'open';
  }

  canRequest(): boolean {
    return this.state !== 'open';
  }

  success(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  failure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.openedAt = this.now();
    }
  }
}
