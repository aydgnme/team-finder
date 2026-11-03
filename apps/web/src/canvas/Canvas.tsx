import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  coverage,
  projectTargets,
  withProposal,
  type BoardAssignment,
  type CandidateView,
  type ExclusionReason,
  type ProjectBoard,
  type SessionInfo,
} from '@team-finder/domain';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, toErrorMessage, type CandidateOptions } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { coach } from '../lib/coach.ts';
import { firstName, formatRange } from '../lib/format.ts';
import { CoverageMeter } from './bars.tsx';
import { CandidateCard, type OpenSlot } from './CandidateCard.tsx';
import { ProposePopover, type ProposalInput } from './ProposePopover.tsx';
import { Slot } from './Slot.tsx';

const DEFAULT_OPTIONS: CandidateOptions = {
  includePartial: true,
  includeRollingOffWithinWeeks: 4,
  includeUnavailable: false,
  includeNearMisses: false,
};

const RELAX: Partial<Record<ExclusionReason, { label: string; patch: Partial<CandidateOptions> }>> = {
  partial: { label: 'include partially available', patch: { includePartial: true } },
  rollingOff: { label: 'include people rolling off within 6 weeks', patch: { includeRollingOffWithinWeeks: 6 } },
  unavailable: { label: 'include unavailable', patch: { includeUnavailable: true } },
  belowMinLevel: { label: 'include near-misses', patch: { includeNearMisses: true } },
};
const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  onProject: 'already on this project',
  noSkillMatch: 'without a matching skill',
  belowMinLevel: 'below a minimum level',
  partial: 'excluded by the full-availability filter',
  rollingOff: 'rolling off later',
  unavailable: 'fully booked',
};

const narrowQuery = '(max-width: 767px)';
function useNarrow() {
  return useSyncExternalStore(
    (l) => {
      const m = window.matchMedia(narrowQuery);
      m.addEventListener('change', l);
      return () => m.removeEventListener('change', l);
    },
    () => window.matchMedia(narrowQuery).matches,
  );
}

interface Placing {
  candidate: CandidateView;
  slot: OpenSlot;
}

export function Canvas({ projectId, session }: { projectId: string; session: SessionInfo }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const narrow = useNarrow();
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [dragging, setDragging] = useState<CandidateView | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [slotError, setSlotError] = useState<{ key: string; message: string } | null>(null);
  const addButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const board = useQuery({ queryKey: ['board', projectId], queryFn: () => api.board(projectId) });
  const candidates = useQuery({
    queryKey: ['candidates', projectId, options],
    queryFn: () => api.candidates(projectId, options),
    placeholderData: keepPreviousData,
  });

  const data = board.data;
  const skillName = useCallback((id: string) => data?.skills.find((s) => s.id === id)?.name ?? 'skill', [data]);
  const roleName = useCallback((id: string) => data?.roles.find((r) => r.id === id)?.name ?? 'Role', [data]);

  const slots = useMemo(() => (data ? buildSlots(data, roleName) : []), [data, roleName]);
  const openSlots: OpenSlot[] = slots
    .filter((s) => !s.assignment)
    .map(({ key, roleId, label }) => ({ key, roleId, label }));
  const cov = useMemo(() => (data ? teamCoverage(data, dragging) : null), [data, dragging]);

  const propose = useMutation({
    mutationFn: ({ candidate, slot, input }: Placing & { input: ProposalInput }) =>
      api.propose({
        projectId,
        userId: candidate.userId,
        slotRoleId: slot.roleId,
        roleIds: input.roleIds,
        hoursPerDay: input.hoursPerDay,
        from: input.from,
        comment: input.comment,
      }),
    // Optimistic: the domain computes the new capacity locally; the API confirms or we snap back.
    onMutate: async ({ candidate, slot, input }) => {
      await queryClient.cancelQueries({ queryKey: ['board', projectId] });
      const previous = queryClient.getQueryData<ProjectBoard>(['board', projectId]);
      if (previous) {
        const check = withProposal(candidate.timeline, input.hoursPerDay, input.from, previous.window);
        const optimistic: BoardAssignment = {
          id: `optimistic-${candidate.userId}`,
          userId: candidate.userId,
          userName: candidate.name,
          slotRoleId: slot.roleId,
          roleIds: [slot.roleId, ...input.roleIds],
          status: 'proposed',
          hoursPerDay: input.hoursPerDay,
          from: input.from,
          to: previous.project.deadline,
          version: 0,
          skills: candidate.skills,
          check: { fits: check.fits, worst: check.worst, maxHours: check.maxHours },
        };
        queryClient.setQueryData<ProjectBoard>(['board', projectId], {
          ...previous,
          assignments: [...previous.assignments, optimistic],
        });
      }
      return { previous };
    },
    onError: (error, { slot, candidate }, context) => {
      if (context?.previous) queryClient.setQueryData(['board', projectId], context.previous);
      const message = toErrorMessage(error);
      setSlotError({ key: slot.key, message });
      announce(`${candidate.name} was not proposed: ${message}`, 'error');
      setTimeout(() => setSlotError((e) => (e?.key === slot.key ? null : e)), 8000);
    },
    onSuccess: (_view, { candidate, slot }) => {
      const after = queryClient.getQueryData<ProjectBoard>(['board', projectId]);
      const pct = after ? Math.round(teamCoverage(after, null).planned * 100) : null;
      announce(
        `${candidate.name} proposed for ${slot.label.replace(/ \d+$/, '')}.${pct === null ? '' : ` Coverage ${pct}%.`}`,
      );
      coach.show('switchToManager');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['board', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['candidates', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const closePopover = (userId: string | undefined) => {
    setPlacing(null);
    if (userId) requestAnimationFrame(() => addButtons.current.get(userId)?.focus());
  };

  const onDragStart = (e: DragStartEvent) => {
    setDragging((e.active.data.current as { candidate: CandidateView }).candidate);
    setSlotError(null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const candidate = (e.active.data.current as { candidate: CandidateView } | undefined)?.candidate;
    setDragging(null);
    const slot = openSlots.find((s) => s.key === e.over?.id);
    if (candidate && slot) setPlacing({ candidate, slot });
  };

  if (board.isPending) return <CanvasSkeleton />;
  if (board.isError || !data) {
    return (
      <main className="canvas">
        <p role="alert">{toErrorMessage(board.error)}</p>
        <button type="button" className="btn" onClick={() => void board.refetch()}>
          Retry
        </button>
      </main>
    );
  }

  const open = openSlots.length;
  const pm = session.personas.find((p) => p.id === data.project.pmId);
  const goal =
    `Staff ${data.project.name}: ` +
    (open === 0 ? 'all slots filled' : `${open} slot${open === 1 ? '' : 's'} open`) +
    (cov && cov.missing.length > 0 ? `, ${cov.missing.join(', ')} not covered` : ', all skills covered');

  const list = candidates.data?.candidates ?? [];
  const now = list.filter((c) => c.availability.kind === 'available' || c.availability.kind === 'partial');
  const later = list.filter((c) => c.availability.kind === 'rollingOff');
  const booked = list.filter((c) => c.availability.kind === 'unavailable');

  const card = (c: CandidateView) => (
    <CandidateCard
      key={c.userId}
      ref={(el) => {
        addButtons.current.set(c.userId, el);
      }}
      candidate={c}
      window={data.window}
      skillName={skillName}
      canStaff={data.canStaff}
      draggable={!narrow}
      openSlots={openSlots}
      onChooseSlot={(slot) => setPlacing({ candidate: c, slot })}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> {data.project.name}
          <span className="muted mono"> · {formatRange(data.project.startDate, data.project.deadline)}</span>
        </p>
        <h1 className="goal" data-testid="goal">
          {goal}
        </h1>
      </header>
      <main className="canvas">
        <section className="slots" aria-labelledby="slots-title">
          <div className="section-head">
            <h2 id="slots-title">Role slots</h2>
            {cov && <CoverageMeter committed={cov.committed} planned={cov.planned} missing={cov.missing} />}
          </div>
          {!data.canStaff && (
            <p className="note">
              Viewing as {firstName(session.user.name)}: only {pm ? pm.name : 'the project manager'} can propose people
              for {data.project.name}.
            </p>
          )}
          {data.project.teamRoles.length === 0 && <p className="muted">Add roles to this project to start staffing.</p>}
          {data.project.teamRoles.map((tr) => (
            <div className="role-row" key={tr.roleId}>
              <h3 className="role-name">{roleName(tr.roleId)}</h3>
              <div className="role-slots">
                {slots
                  .filter((s) => s.roleId === tr.roleId)
                  .map((s) => (
                    <Slot
                      key={s.key}
                      slotKey={s.key}
                      roleId={s.roleId}
                      roleName={roleName(s.roleId)}
                      index={s.index}
                      assignment={s.assignment}
                      dragging={dragging}
                      window={data.window}
                      error={slotError?.key === s.key ? slotError.message : null}
                    >
                      {placing?.slot.key === s.key && (
                        <ProposePopover
                          candidate={placing.candidate}
                          roleId={s.roleId}
                          roleName={roleName(s.roleId)}
                          roles={data.roles}
                          window={data.window}
                          onCancel={() => closePopover(placing.candidate.userId)}
                          onSubmit={(input) => {
                            propose.mutate({ ...placing, input });
                            closePopover(placing.candidate.userId);
                          }}
                        />
                      )}
                    </Slot>
                  ))}
              </div>
            </div>
          ))}
        </section>

        <aside className="sidebar" aria-labelledby="candidates-title">
          <div className="section-head">
            <h2 id="candidates-title">Candidates</h2>
            <span className="muted">ranked</span>
          </div>
          <Filters options={options} onChange={setOptions} />
          {candidates.isPending && <SkeletonRows n={6} />}
          {candidates.isError && (
            <div role="alert" className="inline-error">
              {toErrorMessage(candidates.error)}{' '}
              <button type="button" className="btn btn-small" onClick={() => void candidates.refetch()}>
                Retry
              </button>
            </div>
          )}
          {candidates.data && list.length === 0 && (
            <EmptyCandidates
              excluded={candidates.data.excluded}
              onRelax={(patch) => setOptions((o) => ({ ...o, ...patch }))}
            />
          )}
          {now.length > 0 && (
            <ul className="cards" aria-label="Available now">
              {now.map(card)}
            </ul>
          )}
          {later.length > 0 && (
            <>
              <h3 className="divider">Later</h3>
              <ul className="cards" aria-label="Rolling off soon">
                {later.map(card)}
              </ul>
            </>
          )}
          {booked.length > 0 && (
            <>
              <h3 className="divider">Fully booked</h3>
              <ul className="cards" aria-label="Fully booked">
                {booked.map(card)}
              </ul>
            </>
          )}
        </aside>
      </main>
      <DragOverlay dropAnimation={{ duration: 120 }}>
        {dragging && (
          <div className="card card-overlay">
            <span className="card-name">{dragging.name}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

interface SlotModel extends OpenSlot {
  index: number;
  assignment: BoardAssignment | undefined;
}

function buildSlots(board: ProjectBoard, roleName: (id: string) => string): SlotModel[] {
  return board.project.teamRoles.flatMap((tr) => {
    const order = { active: 0, deallocationProposed: 0, proposed: 1, rejected: 2, past: 2 } as const;
    const members = board.assignments
      .filter((a) => a.slotRoleId === tr.roleId)
      .sort((a, b) => order[a.status] - order[b.status]);
    return Array.from({ length: Math.max(tr.count, members.length) }, (_, index) => ({
      key: `${tr.roleId}:${index}`,
      roleId: tr.roleId,
      index,
      label: `${roleName(tr.roleId)} ${index + 1}`,
      assignment: members[index],
    }));
  });
}

/** Committed (active) vs planned (active + pending, plus the card being dragged) coverage. */
function teamCoverage(board: ProjectBoard, dragging: CandidateView | null) {
  const targets = projectTargets(board.project);
  const active = board.assignments.filter((a) => a.status === 'active' || a.status === 'deallocationProposed');
  const planned = [...board.assignments, ...(dragging ? [{ skills: dragging.skills }] : [])];
  const p = coverage(targets, planned);
  const name = (id: string) => board.skills.find((s) => s.id === id)?.name ?? 'skill';
  return { committed: coverage(targets, active).ratio, planned: p.ratio, missing: p.missing.map(name) };
}

function Filters({ options, onChange }: { options: CandidateOptions; onChange: (o: CandidateOptions) => void }) {
  return (
    <fieldset className="filters">
      <legend className="sr-only">Candidate filters</legend>
      <label className="toggle">
        <input
          type="checkbox"
          checked={options.includePartial}
          onChange={(e) => onChange({ ...options, includePartial: e.target.checked })}
        />
        Partially available
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={options.includeRollingOffWithinWeeks !== null}
          onChange={(e) => onChange({ ...options, includeRollingOffWithinWeeks: e.target.checked ? 4 : null })}
        />
        Rolling off within
        <select
          aria-label="Weeks"
          value={options.includeRollingOffWithinWeeks ?? 4}
          disabled={options.includeRollingOffWithinWeeks === null}
          onChange={(e) => onChange({ ...options, includeRollingOffWithinWeeks: Number(e.target.value) })}
        >
          {[2, 3, 4, 5, 6].map((w) => (
            <option key={w} value={w}>
              {w} wk
            </option>
          ))}
        </select>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={options.includeUnavailable}
          onChange={(e) => onChange({ ...options, includeUnavailable: e.target.checked })}
        />
        Fully booked
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={options.includeNearMisses}
          onChange={(e) => onChange({ ...options, includeNearMisses: e.target.checked })}
        />
        Near misses
      </label>
    </fieldset>
  );
}

function EmptyCandidates({
  excluded,
  onRelax,
}: {
  excluded: Partial<Record<ExclusionReason, number>>;
  onRelax: (patch: Partial<CandidateOptions>) => void;
}) {
  const [reason, count] = (Object.entries(excluded) as [ExclusionReason, number][])
    .filter(([r, n]) => RELAX[r] && n > 0)
    .sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return (
    <div className="empty">
      <p>No candidates match.</p>
      {reason && RELAX[reason] && (
        <p>
          {count} {count === 1 ? 'person' : 'people'} {EXCLUSION_TEXT[reason]}:{' '}
          <button type="button" className="btn btn-small" onClick={() => onRelax(RELAX[reason]!.patch)}>
            {RELAX[reason]!.label}?
          </button>
        </p>
      )}
    </div>
  );
}

function SkeletonRows({ n }: { n: number }) {
  return (
    <ul className="cards" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="card skeleton" />
      ))}
    </ul>
  );
}

function CanvasSkeleton() {
  return (
    <main className="canvas" aria-busy="true">
      <section className="slots">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-slot" />
        <div className="skeleton skeleton-slot" />
      </section>
      <aside className="sidebar">
        <SkeletonRows n={6} />
      </aside>
    </main>
  );
}
