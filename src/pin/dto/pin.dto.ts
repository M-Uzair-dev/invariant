import { IsNotEmpty, IsString, Matches } from 'class-validator';

export const PIN_REGEX = /^\d{6}$/;
export const PIN_MESSAGE = 'PIN must be exactly 6 digits.';

// Body for routes that need the PIN to go through (topup, approve)
export class PinDto {
  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  pin!: string;
}

export class ChangePinDto {
  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  currentPin!: string;

  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  newPin!: string;
}

export class ResetPinDto {
  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  newPin!: string;
}
