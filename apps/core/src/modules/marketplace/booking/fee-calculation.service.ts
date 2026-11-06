import { Injectable } from '@nestjs/common';

const PLATFORM_FEE_PERCENT = 15;

export interface FeeBreakdown {
  actorPaysCents: number;
  platformFeeCents: number;
  readerReceivesCents: number;
}

@Injectable()
export class FeeCalculationService {
  // calculate fee split for a session. platform takes 15%. reader gets the benefit of rounding.
  calculate(sessionPriceCents: number): FeeBreakdown {
    const platformFeeCents = Math.floor(
      (sessionPriceCents * PLATFORM_FEE_PERCENT) / 100,
    );
    const readerReceivesCents = sessionPriceCents - platformFeeCents;

    return {
      actorPaysCents: sessionPriceCents,
      platformFeeCents,
      readerReceivesCents,
    };
  }
}
