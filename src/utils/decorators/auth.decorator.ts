import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { UserType } from '../../types/userRolesType';
import { AuthGuard } from '../guards/auth.guard';

export const USER_TYPES_KEY = 'user-types';

export const Auth = (...types: UserType[]) =>
  applyDecorators(SetMetadata(USER_TYPES_KEY, types), UseGuards(AuthGuard));
