import { FeeCalculationService } from './fee-calculation.service';

describe('FeeCalculationService', () => {
  let service: FeeCalculationService;

  beforeEach(() => {
    service = new FeeCalculationService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('calculate', () => {
    it('should calculate 15% platform fee for a typical amount', () => {
      const result = service.calculate(10000); // $100.00

      expect(result.actorPaysCents).toBe(10000);
      expect(result.platformFeeCents).toBe(1500);
      expect(result.readerReceivesCents).toBe(8500);
    });

    it('should calculate correctly for a small session price', () => {
      const result = service.calculate(2000); // $20.00

      expect(result.actorPaysCents).toBe(2000);
      expect(result.platformFeeCents).toBe(300);
      expect(result.readerReceivesCents).toBe(1700);
    });

    it('should calculate correctly for a large session price', () => {
      const result = service.calculate(100000); // $1000.00

      expect(result.actorPaysCents).toBe(100000);
      expect(result.platformFeeCents).toBe(15000);
      expect(result.readerReceivesCents).toBe(85000);
    });

    it('should floor the platform fee so reader gets the benefit of rounding', () => {
      // 15% of 3333 = 499.95 → floors to 499
      const result = service.calculate(3333);

      expect(result.platformFeeCents).toBe(499);
      expect(result.readerReceivesCents).toBe(3333 - 499); // 2834
    });

    it('should handle an amount where 15% divides evenly', () => {
      // 15% of 2000 = 300 (exact)
      const result = service.calculate(2000);

      expect(result.platformFeeCents).toBe(300);
      expect(result.readerReceivesCents).toBe(1700);
    });

    it('should handle zero amount', () => {
      const result = service.calculate(0);

      expect(result.actorPaysCents).toBe(0);
      expect(result.platformFeeCents).toBe(0);
      expect(result.readerReceivesCents).toBe(0);
    });

    it('should handle very small amount (1 cent)', () => {
      // 15% of 1 = 0.15 → floors to 0
      const result = service.calculate(1);

      expect(result.platformFeeCents).toBe(0);
      expect(result.readerReceivesCents).toBe(1);
    });

    it('should always satisfy: platformFeeCents + readerReceivesCents == actorPaysCents', () => {
      const testAmounts = [
        0, 1, 7, 99, 100, 333, 1000, 2999, 5001, 10000, 99999,
      ];

      for (const amount of testAmounts) {
        const result = service.calculate(amount);
        expect(result.platformFeeCents + result.readerReceivesCents).toBe(
          result.actorPaysCents,
        );
      }
    });
  });
});
