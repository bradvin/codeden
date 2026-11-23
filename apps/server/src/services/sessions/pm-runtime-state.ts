import type { QueueSender, SwitchPmProviderRequest, UserInput } from "@codeden/contracts";

/** Persisted before asking the runner to replace the live runtime. */
export interface PmSwitch extends SwitchPmProviderRequest {
  id: string;
  rootId: string;
  context: string;
  fromName: string;
  toName: string;
  vendorHistory: boolean;
  /** A definite refusal can be retried or replaced with another choice. */
  refused?: boolean;
}

/** The prepared delivery is kept until its acceptance reaches the server's event store. */
export interface PmDelivery {
  id: string;
  input: UserInput;
  from: QueueSender;
  queuedId?: string;
  noticeIds: string[];
}

export interface PmRuntimeState {
  pmSwitch?: PmSwitch;
  pmRuntimeId?: string;
  pmPriorContext?: string;
  pmDelivery?: PmDelivery;
  pmAcceptedNotices?: string[];
  pmSwitchNotices?: { id: string; message: string }[];
  pmLastDeliveryId?: string;
}
