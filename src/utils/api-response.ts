/** Consistent envelope for every API response. */
export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  message: string;
  code: string;
  details?: unknown;
}

export const ok = <T>(data: T): ApiSuccess<T> => ({ success: true, data });
