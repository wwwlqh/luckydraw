// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Vm} from "forge-std/Vm.sol";
import {Schedule} from "../../src/lib/Schedule.sol";
import {Cadence, Kind, Kinds} from "../../src/Types.sol";

/// @notice External wrapper so revert expectations target a real call frame.
contract ScheduleHarness {
    function nextCutoff(uint256 t, Kind kind) external pure returns (uint64) {
        return Schedule.nextCutoff(t, kind);
    }
}

/// @notice Reads one `cutoffs[]` row from the reference vector file.
/// @dev One external call per row, so the 148 KB document is loaded and discarded inside this contract's own
///      frame instead of accumulating in the test's memory (EVM memory gas is quadratic). Fields are read
///      individually because the generator writes large integers as JSON strings and small ones as numbers;
///      `parseJsonUint` coerces both, while a single struct decode would not.
contract ScheduleVectors {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string private constant FILE = "./test/vectors/spec_vectors.json";

    /// @param i Row index.
    /// @return found False once the index is past the end of the array.
    /// @return t Creation instant.
    /// @return oneDay Expected daily-cadence cutoff.
    /// @return oneWeek Expected weekly-cadence cutoff.
    /// @return oneMonth Expected monthly-cadence cutoff.
    function cutoffAt(uint256 i)
        external
        view
        returns (bool found, uint256 t, uint256 oneDay, uint256 oneWeek, uint256 oneMonth)
    {
        string memory json = VM.readFile(FILE);
        string memory element = string.concat(".cutoffs[", VM.toString(i), "]");
        if (!stdJson.keyExists(json, string.concat(element, ".t"))) return (false, 0, 0, 0, 0);
        found = true;
        t = stdJson.readUint(json, string.concat(element, ".t"));
        oneDay = stdJson.readUint(json, string.concat(element, ".Day"));
        oneWeek = stdJson.readUint(json, string.concat(element, ".Week"));
        oneMonth = stdJson.readUint(json, string.concat(element, ".Month"));
    }
}

/// @notice Unit tests for the UTC cutoff schedule (SPEC §6.1, ADR 007; ACCEPTANCE A14, A41).
/// @dev Vectors come from scripts/spec_reference.py via test/vectors/spec_vectors.json; the named calendar
///      cases are asserted against independently computed UTC timestamps rather than against the formulas.
contract ScheduleTest is Test {
    uint256 internal constant DAY = 86400;
    uint256 internal constant WEEK = 604800;
    /// @dev Day index 4 is 1970-01-05, the first Monday of the epoch.
    uint256 internal constant MONDAY_INDEX = 4;
    /// @dev 2100-01-01 00:00 UTC, the fuzz horizon required by the acceptance evidence.
    uint256 internal constant HORIZON = 4102444800;

    // Independently computed UTC instants (python: datetime(...).timestamp()).
    uint256 internal constant T_2024_02_28_1200 = 1709121600;
    uint256 internal constant T_2024_02_29_0000 = 1709164800;
    uint256 internal constant T_2024_02_29_2359 = 1709251199;
    uint256 internal constant T_2024_03_01_0000 = 1709251200;
    uint256 internal constant T_2026_12_31_1200 = 1798718400;
    uint256 internal constant T_2027_01_01_0000 = 1798761600;
    uint256 internal constant T_2100_02_01_0000 = 4105123200;
    uint256 internal constant T_2100_02_28_0000 = 4107456000;
    uint256 internal constant T_2100_02_28_2359 = 4107542399;
    uint256 internal constant T_2100_03_01_0000 = 4107542400;
    uint256 internal constant T_2026_09_11_0000 = 1789084800; // Friday
    uint256 internal constant T_2026_09_11_1234 = 1789130096;
    uint256 internal constant T_2026_09_14_0000 = 1789344000; // Monday
    uint256 internal constant T_2026_09_21_0000 = 1789948800; // Monday
    uint256 internal constant T_2026_10_01_0000 = 1790812800;

    ScheduleHarness internal harness;
    ScheduleVectors internal vectors;

    function setUp() public {
        harness = new ScheduleHarness();
        vectors = new ScheduleVectors();
    }

    // --- Reference vectors -------------------------------------------------------------------------------

    /// @notice Every cutoff vector, for all seven kinds, must match the reference implementation exactly.
    function test_Cutoffs_MatchAllVectors() public view {
        uint256 checked;
        for (uint256 i = 0;; ++i) {
            (bool found, uint256 t, uint256 oneDay, uint256 oneWeek, uint256 oneMonth) = vectors.cutoffAt(i);
            if (!found) break;
            checked += 1;

            string memory at = string.concat(" at vector ", vm.toString(i), " t=", vm.toString(t));
            assertEq(uint256(Schedule.nextCutoff(t, Kind.Day100)), oneDay, string.concat("Day100", at));
            assertEq(uint256(Schedule.nextCutoff(t, Kind.Day1k)), oneDay, string.concat("Day1k", at));
            assertEq(uint256(Schedule.nextCutoff(t, Kind.Day10k)), oneDay, string.concat("Day10k", at));
            assertEq(uint256(Schedule.nextCutoff(t, Kind.Week1k)), oneWeek, string.concat("Week1k", at));
            assertEq(uint256(Schedule.nextCutoff(t, Kind.Week10k)), oneWeek, string.concat("Week10k", at));
            assertEq(uint256(Schedule.nextCutoff(t, Kind.Week100k)), oneWeek, string.concat("Week100k", at));
            assertEq(uint256(Schedule.nextCutoff(t, Kind.Month100k)), oneMonth, string.concat("Month100k", at));
        }
        assertGt(checked, 100, "cutoff vector set unexpectedly small");
    }

    // --- Named calendar cases ----------------------------------------------------------------------------

    /// @notice February 2024 has 29 days: the 29th is a real day and the month still ends at 2024-03-01.
    function test_LeapFebruary2024() public pure {
        assertEq(uint256(Schedule.nextCutoff(T_2024_02_28_1200, Kind.Day100)), T_2024_02_29_0000, "28 Feb -> 29 Feb");
        assertEq(uint256(Schedule.nextCutoff(T_2024_02_29_0000, Kind.Day100)), T_2024_03_01_0000, "29 Feb -> 1 Mar");
        assertEq(uint256(Schedule.nextCutoff(T_2024_02_29_2359, Kind.Month100k)), T_2024_03_01_0000, "monthly close");
        assertEq(uint256(Schedule.nextCutoff(T_2024_02_28_1200, Kind.Month100k)), T_2024_03_01_0000, "monthly close");

        (uint256 y, uint256 m, uint256 d) = Schedule.civilFromDays(T_2024_02_29_0000 / DAY);
        assertEq(y, 2024, "year");
        assertEq(m, 2, "month");
        assertEq(d, 29, "day");
    }

    /// @notice 2100 is not a leap year under the Gregorian century rule: 28 February is followed by 1 March.
    function test_NonLeapFebruary2100() public pure {
        assertEq(uint256(Schedule.nextCutoff(T_2100_02_28_0000, Kind.Day100)), T_2100_03_01_0000, "28 Feb -> 1 Mar");
        assertEq(uint256(Schedule.nextCutoff(T_2100_02_01_0000, Kind.Month100k)), T_2100_03_01_0000, "monthly close");
        assertEq(uint256(Schedule.nextCutoff(T_2100_02_28_2359, Kind.Month100k)), T_2100_03_01_0000, "monthly close");

        (uint256 y, uint256 m, uint256 d) = Schedule.civilFromDays(T_2100_02_28_2359 / DAY);
        assertEq(y, 2100, "year");
        assertEq(m, 2, "month");
        assertEq(d, 28, "last day of February 2100");
        assertEq(Schedule.daysFromCivil(2100, 3, 1) * DAY, T_2100_03_01_0000, "1 March 2100");
    }

    /// @notice A December round closes at 00:00 UTC on 1 January of the next year.
    function test_YearEnd2026To2027() public pure {
        assertEq(uint256(Schedule.nextCutoff(T_2026_12_31_1200, Kind.Month100k)), T_2027_01_01_0000, "monthly rollover");
        assertEq(uint256(Schedule.nextCutoff(T_2026_12_31_1200, Kind.Day100)), T_2027_01_01_0000, "daily rollover");
        assertEq(
            uint256(Schedule.nextCutoff(T_2027_01_01_0000, Kind.Month100k)), 1801440000, "January 2027 -> 1 Feb 2027"
        );
    }

    /// @notice Friday 2026-09-11 closes on Monday 2026-09-14 00:00 UTC, and a Monday closes a week later.
    function test_WeeklyCutoffIsNextMonday() public pure {
        assertEq(uint256(Schedule.nextCutoff(T_2026_09_11_0000, Kind.Week1k)), T_2026_09_14_0000, "Friday midnight");
        assertEq(uint256(Schedule.nextCutoff(T_2026_09_11_1234, Kind.Week1k)), T_2026_09_14_0000, "Friday midday");
        assertEq(uint256(Schedule.nextCutoff(T_2026_09_14_0000, Kind.Week1k)), T_2026_09_21_0000, "Monday 00:00");
        assertEq(
            uint256(Schedule.nextCutoff(T_2026_09_14_0000 - 1, Kind.Week1k)), T_2026_09_14_0000, "one second before"
        );
        // 1970-01-05 was the first Monday after the epoch.
        assertEq(uint256(Schedule.nextCutoff(0, Kind.Week1k)), 4 * DAY, "epoch");
    }

    /// @notice Every `Kind` maps to the cadence its name states (SPEC §6.1, ADR 036).
    function test_CadenceOfEveryKind() public pure {
        assertEq(uint8(Kinds.cadenceOf(Kind.Day100)), uint8(Cadence.Day));
        assertEq(uint8(Kinds.cadenceOf(Kind.Day1k)), uint8(Cadence.Day));
        assertEq(uint8(Kinds.cadenceOf(Kind.Day10k)), uint8(Cadence.Day));
        assertEq(uint8(Kinds.cadenceOf(Kind.Week1k)), uint8(Cadence.Week));
        assertEq(uint8(Kinds.cadenceOf(Kind.Week10k)), uint8(Cadence.Week));
        assertEq(uint8(Kinds.cadenceOf(Kind.Week100k)), uint8(Cadence.Week));
        assertEq(uint8(Kinds.cadenceOf(Kind.Month100k)), uint8(Cadence.Month));
    }

    /// @notice The default whole-USD target of every `Kind` is the tier its name states (SPEC §6.1, ADR 036).
    function test_DefaultTargetOfEveryKind() public pure {
        assertEq(Kinds.defaultTargetUsd(Kind.Day100), 100);
        assertEq(Kinds.defaultTargetUsd(Kind.Day1k), 1000);
        assertEq(Kinds.defaultTargetUsd(Kind.Day10k), 10_000);
        assertEq(Kinds.defaultTargetUsd(Kind.Week1k), 1000);
        assertEq(Kinds.defaultTargetUsd(Kind.Week10k), 10_000);
        assertEq(Kinds.defaultTargetUsd(Kind.Week100k), 100_000);
        assertEq(Kinds.defaultTargetUsd(Kind.Month100k), 100_000);
    }

    /// @notice The three cadences are independent: the same instant yields three different cutoffs.
    function test_KindsAreDistinct() public pure {
        assertEq(uint256(Schedule.nextCutoff(T_2026_09_11_1234, Kind.Day100)), T_2026_09_11_0000 + DAY, "daily");
        assertEq(uint256(Schedule.nextCutoff(T_2026_09_11_1234, Kind.Week1k)), T_2026_09_14_0000, "weekly");
        assertEq(uint256(Schedule.nextCutoff(T_2026_09_11_1234, Kind.Month100k)), T_2026_10_01_0000, "monthly");
    }

    /// @notice Days since the epoch round-trip through the civil-date conversions.
    function test_CivilConversionsAtKnownDates() public pure {
        assertEq(Schedule.daysFromCivil(1970, 1, 1), 0, "epoch day");
        assertEq(Schedule.daysFromCivil(2000, 3, 1) * DAY, 951868800, "2000-03-01");
        assertEq(Schedule.daysFromCivil(2026, 9, 11) * DAY, T_2026_09_11_0000, "2026-09-11");

        (uint256 y, uint256 m, uint256 d) = Schedule.civilFromDays(0);
        assertEq(y, 1970, "epoch year");
        assertEq(m, 1, "epoch month");
        assertEq(d, 1, "epoch day of month");
    }

    // --- Properties --------------------------------------------------------------------------------------

    /// @notice The four schedule invariants hold for every kind across the supported horizon.
    function testFuzz_CutoffInvariants(uint256 t, uint8 rawKind) public pure {
        t = bound(t, 0, HORIZON);
        Kind kind = Kind(uint8(bound(rawKind, 0, 2)));

        uint256 c = uint256(Schedule.nextCutoff(t, kind));
        assertGt(c, t, "cutoff must be strictly after the creation time");
        assertEq(c % DAY, 0, "cutoff must be a UTC midnight");
        assertEq(uint256(Schedule.nextCutoff(c - 1, kind)), c, "the second before a cutoff still closes at it");
        assertGt(uint256(Schedule.nextCutoff(c, kind)), c, "at the cutoff the successor period starts");
    }

    /// @notice Each kind's cutoff falls inside its maximum period length.
    function testFuzz_CutoffWithinPeriod(uint256 t) public pure {
        t = bound(t, 0, HORIZON);

        uint256 daily = uint256(Schedule.nextCutoff(t, Kind.Day100));
        assertLe(daily - t, DAY, "daily cutoff within one day");

        uint256 weekly = uint256(Schedule.nextCutoff(t, Kind.Week1k));
        assertLe(weekly - t, WEEK, "weekly cutoff within one week");
        assertEq((weekly / DAY) % 7, MONDAY_INDEX, "weekly cutoff lands on a Monday");

        uint256 monthly = uint256(Schedule.nextCutoff(t, Kind.Month100k));
        assertLe(monthly - t, 31 * DAY, "monthly cutoff within 31 days");
        assertGe(monthly - t, 1, "monthly cutoff strictly ahead");
    }

    /// @notice A monthly cutoff is the first day of a month and the day before it is not.
    function testFuzz_MonthlyCutoffIsFirstOfMonth(uint256 t) public pure {
        t = bound(t, 0, HORIZON);
        uint256 c = uint256(Schedule.nextCutoff(t, Kind.Month100k));

        (uint256 y, uint256 m, uint256 d) = Schedule.civilFromDays(c / DAY);
        assertEq(d, 1, "cutoff day of month");
        assertTrue(m >= 1 && m <= 12, "month in range");
        assertEq(Schedule.daysFromCivil(y, m, d), c / DAY, "civil date round-trips");

        (,, uint256 previousDay) = Schedule.civilFromDays(c / DAY - 1);
        assertGt(previousDay, 1, "the previous day closes the previous month");
    }

    /// @notice civilFromDays and daysFromCivil are mutual inverses over the supported horizon.
    function testFuzz_CivilRoundTrip(uint256 z) public pure {
        z = bound(z, 0, HORIZON / DAY);
        (uint256 y, uint256 m, uint256 d) = Schedule.civilFromDays(z);

        assertGe(y, 1970, "year at or after the epoch");
        assertTrue(m >= 1 && m <= 12, "month in range");
        assertTrue(d >= 1 && d <= 31, "day in range");
        assertEq(Schedule.daysFromCivil(y, m, d), z, "round-trip");
    }

    /// @notice Consecutive days advance the calendar by exactly one day.
    function testFuzz_CivilIsStrictlyIncreasing(uint256 z) public pure {
        z = bound(z, 0, HORIZON / DAY - 1);
        (uint256 y0, uint256 m0, uint256 d0) = Schedule.civilFromDays(z);
        (uint256 y1, uint256 m1, uint256 d1) = Schedule.civilFromDays(z + 1);

        if (d1 == 1) {
            // A month boundary: either the next month of the same year or 1 January of the next year.
            assertTrue((y1 == y0 && m1 == m0 + 1) || (y1 == y0 + 1 && m0 == 12 && m1 == 1), "month rollover");
        } else {
            assertEq(y1, y0, "same year");
            assertEq(m1, m0, "same month");
            assertEq(d1, d0 + 1, "next day");
        }
    }

    // --- Overflow ----------------------------------------------------------------------------------------

    /// @notice A cutoff that does not fit in uint64 reverts with Solidity's arithmetic panic (SPEC §8.1).
    function test_RevertWhen_CutoffExceedsUint64() public {
        uint256 t = type(uint64).max;
        vm.expectRevert(stdError.arithmeticError);
        harness.nextCutoff(t, Kind.Day100);

        vm.expectRevert(stdError.arithmeticError);
        harness.nextCutoff(t, Kind.Week1k);

        vm.expectRevert(stdError.arithmeticError);
        harness.nextCutoff(t, Kind.Month100k);
    }

    /// @notice The largest uint64-representable daily cutoff is still accepted.
    function test_LargestRepresentableDailyCutoff() public pure {
        uint256 lastMidnight = (uint256(type(uint64).max) / DAY) * DAY;
        assertEq(uint256(Schedule.nextCutoff(lastMidnight - 1, Kind.Day100)), lastMidnight, "boundary accepted");
    }
}
