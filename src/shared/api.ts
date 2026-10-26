export interface OwnerActor {
  type: "owner";
  id: string;
  email?: string;
  authentication: "access" | "local" | "service-token";
}

export interface MeResponse {
  actor: OwnerActor;
}

export interface ApiError {
  error: {
    code: "invalid" | "not_found" | "conflict" | "busy" | "unavailable" | "budget";
    message: string;
  };
}
