"""Deliberate RED: expect successful JSON for each of the three real failures."""
import sys
import unittest

from test_parity_boundary_release import ParityBoundaryReleaseWitnesses

# Test-only expectation mutation. Runner/harness/subprocess/JSON stay unchanged.
ParityBoundaryReleaseWitnesses.expected_ok = True
suite = unittest.defaultTestLoader.loadTestsFromTestCase(ParityBoundaryReleaseWitnesses)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(not result.wasSuccessful())
