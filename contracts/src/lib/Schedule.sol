// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Panic} from "@openzeppelin/contracts/utils/Panic.sol";
import {Cadence, Kind, Kinds} from "../Types.sol";
import {InvalidKind} from "../Errors.sol";

/// @title Schedule
/// @notice Fixed UTC round cutoffs: next midnight, next Monday 00:00 and the next calendar month start
///         (SPEC §6.1, ADR 007). Every function is pure; the library never accepts a caller-supplied cutoff.
/// @dev The calendar conversions are Howard Hinnant's public-domain `civil_from_days` / `days_from_civil`
///      algorithms as transcribed in SPEC §6.1. For a Unix timestamp t >= 0 every intermediate value is
///      nonnegative, so unsigned arithmetic with floor division reproduces them exactly. All arithmetic is
///      checked: an out-of-range input surfaces as Solidity's Panic(0x11) rather than a silent wrap.
library Schedule {
    /// @dev Seconds per UTC day.
    uint256 internal constant DAY = 86400;

    /// @dev Seconds per week.
    uint256 internal constant WEEK = 604800;

    /// @dev 1970-01-01 was a Thursday; shifting by three days makes each week start on Monday 00:00 UTC.
    uint256 internal constant WEEK_OFFSET = 259200;

    /// @dev Days from 0000-03-01 (the algorithm's internal epoch) to 1970-01-01.
    uint256 internal constant DAYS_SHIFT = 719468;

    /// @dev Days in a 400-year Gregorian era.
    uint256 internal constant ERA_DAYS = 146097;

    /// @dev Largest representable cutoff; `closesAt` is stored as uint64 (SPEC §5.1).
    uint256 private constant MAX_CUTOFF = type(uint64).max;

    /// @notice Returns the round cutoff strictly after `t` for the given sequence kind.
    /// @dev The kind's cadence (`Kinds.cadenceOf`) picks the boundary: Day `(t/86400+1)*86400`; Week
    ///      `((t+259200)/604800+1)*604800-259200`; Month 00:00 UTC on the first day of the next calendar
    ///      month. The result is always a multiple of 86400, strictly greater
    ///      than `t`, and idempotent in the sense that `nextCutoff(result-1)==result`. A result that does not
    ///      fit in uint64 reverts with Panic(0x11) (SPEC §8.1: overflow has no custom error).
    /// @param t Creation time in seconds since the Unix epoch (UTC).
    /// @param kind Round sequence kind.
    /// @return closesAt The next cutoff as a uint64 UTC timestamp.
    function nextCutoff(uint256 t, Kind kind) internal pure returns (uint64 closesAt) {
        uint256 cutoff;
        Cadence cadence = Kinds.cadenceOf(kind);
        if (cadence == Cadence.Day) {
            cutoff = (t / DAY + 1) * DAY;
        } else if (cadence == Cadence.Week) {
            cutoff = ((t + WEEK_OFFSET) / WEEK + 1) * WEEK - WEEK_OFFSET;
        } else if (cadence == Cadence.Month) {
            (uint256 y, uint256 m,) = civilFromDays(t / DAY);
            if (m == 12) {
                y += 1;
                m = 1;
            } else {
                m += 1;
            }
            cutoff = daysFromCivil(y, m, 1) * DAY;
        } else {
            // Unreachable while `Cadence` covers every `Kind`; kept so a future cadence cannot silently
            // fall through to a zero cutoff.
            revert InvalidKind();
        }
        if (cutoff > MAX_CUTOFF) Panic.panic(Panic.UNDER_OVERFLOW);
        closesAt = uint64(cutoff);
    }

    /// @notice Converts days since 1970-01-01 into a proleptic Gregorian civil date.
    /// @dev Howard Hinnant's `civil_from_days`, unsigned form (SPEC §6.1). Exposed for tests and for callers
    ///      that need the calendar date of a stored timestamp.
    /// @param z Days since 1970-01-01 (z = floor(t / 86400)).
    /// @return y Year.
    /// @return m Month, 1-12.
    /// @return d Day of month, 1-31.
    function civilFromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += DAYS_SHIFT;
        uint256 era = z / ERA_DAYS;
        uint256 doe = z - era * ERA_DAYS; // [0, 146096]
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
        uint256 mp = (5 * doy + 2) / 153; // [0, 11], March-based
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    }

    /// @notice Converts a proleptic Gregorian civil date into days since 1970-01-01.
    /// @dev Howard Hinnant's `days_from_civil`, unsigned form (SPEC §6.1). Defined for dates on or after
    ///      1970-01-01; earlier dates underflow and revert with Panic(0x11). The caller supplies a valid
    ///      (y, m, d); an out-of-range month or day yields a normalised, not rejected, day count.
    /// @param y Year, 1970 or later.
    /// @param m Month, 1-12.
    /// @param d Day of month, 1-31.
    /// @return Days since 1970-01-01.
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        y -= m <= 2 ? 1 : 0;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400; // [0, 399]
        uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1; // [0, 365]
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
        return era * ERA_DAYS + doe - DAYS_SHIFT;
    }
}
