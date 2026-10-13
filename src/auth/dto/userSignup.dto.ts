import {
  IsEmail,
  Matches,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PIN_MESSAGE, PIN_REGEX } from '../../pin/dto/pin.dto';

export class UserSignupDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password!: string;

  @IsString()
  @Matches(PIN_REGEX, { message: PIN_MESSAGE })
  pin!: string;
}
