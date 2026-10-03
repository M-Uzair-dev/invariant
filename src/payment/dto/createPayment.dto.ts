import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
} from 'class-validator';

// $1,000,000 in cents. Keeps amounts well inside Number.MAX_SAFE_INTEGER
// before they're converted to BigInt for the amountCents column.
export const MAX_PAYMENT_CENTS = 100_000_000;

export class CreatePaymentDto {
  @IsInt()
  @IsPositive()
  @Max(MAX_PAYMENT_CENTS)
  amountCents!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  orderId!: string;

  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  returnUrl!: string;
}
