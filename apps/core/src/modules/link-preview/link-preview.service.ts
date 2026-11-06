/** biome-ignore-all lint/style/useImportType: <> */
import * as crypto from 'node:crypto';
import { RedisLockService } from '@app/common';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

type Platform = 'youtube' | 'vimeo' | 'soundcloud' | 'generic';

export interface LinkPreviewResult {
  title: string | null;
  thumbnailUrl: string | null;
  platform: Platform;
}

const CACHE_PREFIX = 'link-preview:';
const CACHE_TTL_SECONDS = 86_400; // 24 h
const FETCH_TIMEOUT_MS = 4_000;
const MAX_HTML_BYTES = 100_000; // 100 KB cap for generic OG scrape

const OEMBED_ENDPOINTS: Record<Exclude<Platform, 'generic'>, string> = {
  youtube: 'https://www.youtube.com/oembed',
  vimeo: 'https://vimeo.com/api/oembed.json',
  soundcloud: 'https://soundcloud.com/oembed',
};

@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly redisLockService: RedisLockService,
  ) {}

  async preview(url: string): Promise<LinkPreviewResult> {
    const cacheKey =
      CACHE_PREFIX + crypto.createHash('sha256').update(url).digest('hex');

    // 1. cache hit - return immediately (best-effort — Redis unavailability is non-fatal)
    try {
      const cached = await this.redisLockService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as LinkPreviewResult;
      }
    } catch (err) {
      this.logger.warn(
        `link-preview cache read failed (Redis unavailable?): ${(err as Error).message}`,
      );
    }

    // 2. fetch
    const platform = this.detectPlatform(url);
    let result: LinkPreviewResult;
    try {
      result =
        platform !== 'generic'
          ? await this.fetchOEmbed(url, platform)
          : await this.fetchOG(url);
    } catch (err) {
      this.logger.warn(
        `link-preview fetch failed for ${url}: ${(err as Error).message}`,
      );
      result = { title: null, thumbnailUrl: null, platform };
    }

    // 3. cache result (best-effort — Redis unavailability is non-fatal)
    try {
      await this.redisLockService.setWithTTL(
        cacheKey,
        JSON.stringify(result),
        CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `link-preview cache write failed (Redis unavailable?): ${(err as Error).message}`,
      );
    }

    return result;
  }

  private detectPlatform(url: string): Platform {
    try {
      const { hostname } = new URL(url);
      if (hostname.includes('youtube.com') || hostname.includes('youtu.be'))
        return 'youtube';
      if (hostname.includes('vimeo.com')) return 'vimeo';
      if (hostname.includes('soundcloud.com')) return 'soundcloud';
    } catch {
      // malformed URL — fall through to generic
    }
    return 'generic';
  }

  private async fetchOEmbed(
    url: string,
    platform: Exclude<Platform, 'generic'>,
  ): Promise<LinkPreviewResult> {
    const endpoint = `${OEMBED_ENDPOINTS[platform]}?url=${encodeURIComponent(url)}&format=json`;
    const { data } = await firstValueFrom(
      this.httpService.get<{ title?: string; thumbnail_url?: string }>(
        endpoint,
        { timeout: FETCH_TIMEOUT_MS },
      ),
    );
    return {
      title: data.title ?? null,
      thumbnailUrl: data.thumbnail_url ?? null,
      platform,
    };
  }

  // lightweight OG scraper — no extra deps, just axios + regex on the <head>.
  private async fetchOG(url: string): Promise<LinkPreviewResult> {
    const { data: html } = await firstValueFrom(
      this.httpService.get<string>(url, {
        timeout: FETCH_TIMEOUT_MS,
        responseType: 'text',
        maxContentLength: MAX_HTML_BYTES,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; CueActorBot/1.0; +https://cueactor.com)',
          Accept: 'text/html',
        },
      }),
    );

    // only parse up to </head> to avoid scanning large bodies
    const head =
      html.slice(0, html.toLowerCase().indexOf('</head>') + 7) || html;

    return {
      title:
        this.extractOgMeta(head, 'og:title') ?? this.extractTitle(head) ?? null,
      thumbnailUrl: this.extractOgMeta(head, 'og:image') ?? null,
      platform: 'generic',
    };
  }

  // handles both attribute orderings: property=... content=... and content=... property=...
  private extractOgMeta(html: string, property: string): string | undefined {
    const escaped = property.replace(':', '\\:');
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
        'i',
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
        'i',
      ),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1].trim();
    }
    return undefined;
  }

  private extractTitle(html: string): string | undefined {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m?.[1]?.trim();
  }
}
