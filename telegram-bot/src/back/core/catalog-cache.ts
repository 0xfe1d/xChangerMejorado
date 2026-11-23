import { ulid } from 'ulid';
import { Carrera, Curso, Grupo } from '../../contracts';
import { RedisLike } from '../storage/redis-stores';

const DEFAULT_CACHE_TTL_SEC = 5 * 60; // 5 min (§6.8)
const VERSION_TTL_SEC = 60 * 60; // > TTL de datos para evitar colisiones tras expiración

const CAREERS_KEY = 'tg:cache:catalog:careers';
const COURSES_VER_KEY = 'tg:cache:catalog:ver:courses';
const GROUPS_VER_KEY = 'tg:cache:catalog:ver:groups';

export type AcademicEntity = 'CARRERA' | 'CURSO' | 'ASIGNATURA' | 'GRUPO';

function parseJsonArray<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

/**
 * Caché de catálogo y grupos de asignaturas en Redis bajo `tg:cache:catalog:*` (§6.8, §11).
 * Usa claves versionadas para invalidar cursos y grupos en O(1) sin necesitar `SCAN`/`KEYS`.
 */
export class RedisCatalogCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSec = DEFAULT_CACHE_TTL_SEC,
  ) {}

  private async getVersion(versionKey: string): Promise<string> {
    return (await this.redis.get(versionKey)) ?? '0';
  }

  private async bumpVersion(versionKey: string): Promise<void> {
    await this.redis.set(versionKey, ulid(), 'EX', VERSION_TTL_SEC);
  }

  private async readList<T>(key: string): Promise<T[] | null> {
    const raw = await this.redis.get(key);
    return parseJsonArray<T>(raw);
  }

  private async writeList<T>(key: string, items: T[]): Promise<void> {
    await this.redis.set(key, JSON.stringify(items), 'EX', this.ttlSec);
  }

  async getCareers(): Promise<Carrera[] | null> {
    return this.readList<Carrera>(CAREERS_KEY);
  }

  async setCareers(careers: Carrera[]): Promise<void> {
    await this.writeList(CAREERS_KEY, careers);
  }

  async getCourses(carreraId: string): Promise<Curso[] | null> {
    const ver = await this.getVersion(COURSES_VER_KEY);
    return this.readList<Curso>(`tg:cache:catalog:courses:${ver}:${carreraId}`);
  }

  async setCourses(carreraId: string, courses: Curso[]): Promise<void> {
    const ver = await this.getVersion(COURSES_VER_KEY);
    await this.writeList(`tg:cache:catalog:courses:${ver}:${carreraId}`, courses);
  }

  async getGroups(asignaturaId: string): Promise<Grupo[] | null> {
    const ver = await this.getVersion(GROUPS_VER_KEY);
    return this.readList<Grupo>(`tg:cache:catalog:groups:${ver}:${asignaturaId}`);
  }

  async setGroups(asignaturaId: string, groups: Grupo[]): Promise<void> {
    const ver = await this.getVersion(GROUPS_VER_KEY);
    await this.writeList(`tg:cache:catalog:groups:${ver}:${asignaturaId}`, groups);
  }

  /**
   * Invalida las entradas afectadas ante eventos `academic.changed` del Core (§11).
   */
  async invalidateByAcademicEvent(entity: AcademicEntity): Promise<void> {
    if (entity === 'CARRERA') {
      await Promise.all([
        this.redis.del(CAREERS_KEY),
        this.bumpVersion(COURSES_VER_KEY),
        this.bumpVersion(GROUPS_VER_KEY),
      ]);
      return;
    }

    if (entity === 'CURSO') {
      await Promise.all([
        this.bumpVersion(COURSES_VER_KEY),
        this.bumpVersion(GROUPS_VER_KEY),
      ]);
      return;
    }

    await this.bumpVersion(GROUPS_VER_KEY);
  }
}
