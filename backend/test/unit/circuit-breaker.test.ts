import { CircuitBreaker } from '../../src/utils/circuit-breaker';

describe('CircuitBreaker (§10.3)', () => {
  it('se abre tras 5 fallos consecutivos y deja pasar una prueba a los 30 s', () => {
    let now = 0;
    const cb = new CircuitBreaker(5, 30_000, () => now);
    for (let i = 0; i < 4; i++) cb.failure();
    expect(cb.state).toBe('closed');
    cb.failure();
    expect(cb.state).toBe('open');
    expect(cb.canRequest()).toBe(false);
    now = 30_000;
    expect(cb.state).toBe('half-open');
    expect(cb.canRequest()).toBe(true);
  });

  it('un fallo en semiabierto vuelve a abrir; un éxito lo cierra', () => {
    let now = 0;
    const cb = new CircuitBreaker(5, 30_000, () => now);
    for (let i = 0; i < 5; i++) cb.failure();
    now = 30_001;
    cb.failure();
    expect(cb.state).toBe('open');
    now = 70_000;
    cb.success();
    expect(cb.state).toBe('closed');
  });

  it('un éxito reinicia el contador de fallos', () => {
    const cb = new CircuitBreaker(5, 30_000, () => 0);
    for (let i = 0; i < 4; i++) cb.failure();
    cb.success();
    for (let i = 0; i < 4; i++) cb.failure();
    expect(cb.state).toBe('closed');
  });
});
