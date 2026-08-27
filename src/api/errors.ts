export interface ApiErrorBody {
  error: { code: string; message: string; providerCode?: number };
}

export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly providerCode?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.providerCode === undefined ? {} : { providerCode: this.providerCode }),
      },
    };
  }
}
