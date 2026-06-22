/**
 * A generic Applicant-Tracking-System / HRIS surface — NOT a real vendor.
 *
 * The macros that drive recruiter workflows all go through this interface. The
 * shipped implementation is an in-memory, fixtured store (no network, no real
 * vendor API): the reference vertical is a teaching artifact, and there is no
 * universal public ATS API to point at the way github-maintainer points at
 * github.com. An adopter swaps `InMemoryAtsClient` for a thin client over their
 * own Greenhouse / Lever / Workday / custom HRIS, keeping these typed shapes so
 * the dependency stays local to this file.
 *
 * Every mutation (interview creation, candidate message, reference request) is
 * a deliberate, named method — the macros that call them default to dry-run so
 * a human approves before anything leaves the system (see the macro safety
 * note). All people/data here are SYNTHETIC (see ../fixtures/dataset.ts).
 */

export type EmploymentType = "full_time" | "part_time" | "contract" | "intern";
export type RequisitionStatus = "open" | "on_hold" | "closed";
export type CandidateStage =
  | "applied"
  | "screen"
  | "interview"
  | "offer"
  | "hired"
  | "rejected";

export interface Requisition {
  id: string;
  title: string;
  /** Seniority band, e.g. "junior" | "mid" | "senior" | "staff" | "principal". */
  level: string;
  location: string;
  remote: boolean;
  employmentType: EmploymentType;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  minYearsExperience: number;
  description: string;
  hiringManager: string;
  status: RequisitionStatus;
}

export interface CandidateReference {
  name: string;
  relationship: string;
  /** Synthetic contact only (example.test addresses). */
  email: string;
}

export interface Candidate {
  id: string;
  /** Application this candidate belongs to. */
  requisitionId: string;
  name: string;
  headline: string;
  location: string;
  remoteOk: boolean;
  yearsExperience: number;
  currentTitle: string;
  skills: string[];
  /** Free-text resume body — synthetic. */
  resumeText: string;
  references: CandidateReference[];
  stage: CandidateStage;
  /** Synthetic contact only (example.test addresses). */
  email: string;
}

export interface InterviewInvite {
  candidateId: string;
  requisitionId: string;
  interviewers: string[];
  /** ISO-8601 start times offered to the candidate. */
  proposedSlots: string[];
  stage: string;
  durationMinutes: number;
}

export interface OutreachMessage {
  candidateId: string;
  subject: string;
  body: string;
}

export interface ReferenceRequest {
  candidateId: string;
  reference: CandidateReference;
  body: string;
}

/** Records of mutations actually committed (only when a macro is told to send). */
export interface AtsMutationLog {
  interviews: InterviewInvite[];
  messages: OutreachMessage[];
  referenceRequests: ReferenceRequest[];
}

export interface AtsClient {
  getRequisition(id: string): Promise<Requisition>;
  listRequisitions(): Promise<Requisition[]>;
  getCandidate(id: string): Promise<Candidate>;
  /** Candidates in a requisition's pipeline. */
  listCandidates(requisitionId: string): Promise<Candidate[]>;
  // --- mutations (consequential; macros gate these behind an explicit send flag) ---
  createInterview(invite: InterviewInvite): Promise<{ id: string }>;
  sendMessage(message: OutreachMessage): Promise<{ id: string }>;
  requestReference(request: ReferenceRequest): Promise<{ id: string }>;
}

export interface AtsDataset {
  requisitions: Requisition[];
  candidates: Candidate[];
}

export class AtsNotFoundError extends Error {
  constructor(
    readonly kind: "requisition" | "candidate",
    readonly id: string,
  ) {
    super(`${kind} "${id}" not found`);
    this.name = "AtsNotFoundError";
  }
}

/**
 * The shipped fixtured client. Reads from an in-memory dataset; mutations are
 * recorded in `mutations` so tests (and the macros' own return values) can
 * observe what *would* be sent, without anything leaving the process.
 */
export class InMemoryAtsClient implements AtsClient {
  readonly mutations: AtsMutationLog = { interviews: [], messages: [], referenceRequests: [] };
  private readonly requisitions: Map<string, Requisition>;
  private readonly candidates: Map<string, Candidate>;
  private seq = 0;

  constructor(dataset: AtsDataset) {
    this.requisitions = new Map(dataset.requisitions.map((r) => [r.id, r]));
    this.candidates = new Map(dataset.candidates.map((c) => [c.id, c]));
  }

  async getRequisition(id: string): Promise<Requisition> {
    const r = this.requisitions.get(id);
    if (!r) throw new AtsNotFoundError("requisition", id);
    return r;
  }

  async listRequisitions(): Promise<Requisition[]> {
    return [...this.requisitions.values()];
  }

  async getCandidate(id: string): Promise<Candidate> {
    const c = this.candidates.get(id);
    if (!c) throw new AtsNotFoundError("candidate", id);
    return c;
  }

  async listCandidates(requisitionId: string): Promise<Candidate[]> {
    return [...this.candidates.values()].filter((c) => c.requisitionId === requisitionId);
  }

  async createInterview(invite: InterviewInvite): Promise<{ id: string }> {
    this.mutations.interviews.push(invite);
    return { id: `iv_${++this.seq}` };
  }

  async sendMessage(message: OutreachMessage): Promise<{ id: string }> {
    this.mutations.messages.push(message);
    return { id: `msg_${++this.seq}` };
  }

  async requestReference(request: ReferenceRequest): Promise<{ id: string }> {
    this.mutations.referenceRequests.push(request);
    return { id: `ref_${++this.seq}` };
  }
}
