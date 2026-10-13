import { IsInt, IsPositive, Max } from 'class-validator';
import { PinDto } from '../../pin/dto/pin.dto';

// $1,000,000 in cents, same ceiling as payments: keeps amounts well inside
// Number.MAX_SAFE_INTEGER before they're converted to BigInt.
export const MAX_TOPUP_CENTS = 100_000_000;

export class TopupDto extends PinDto {
  @IsInt()
  @IsPositive()
  @Max(MAX_TOPUP_CENTS)
  amountCents!: number;
}
