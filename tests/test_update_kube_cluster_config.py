"""
Comprehensive tests for src.v2.kube.update_kube_cluster_config.

Tests every cluster entry archetype alone, in pairs, and in triples to ensure
the matching/priority logic works regardless of what other tools have written
to the same kubeconfig.

All tests use: local_server="my.endpoint.com", local_port=9443
unless stated otherwise.

Entry archetypes (with respect to the above local_server/local_port):
  ARN_SAME_PORT     — ARN name, direct host match, same port (9443)         → eligible (same_port)
  ARN_NO_PORT       — ARN name, direct host match, no port                  → eligible (same_port)
  ARN_PORT_443      — ARN name, direct host match, port 443 (≠9443)         → falls through
  ARN_DIFF_PORT     — ARN name, direct host match, different non-443 port   → skipped
  TLS_127           — ARN name, TLS SNI match, host=127.0.0.1, same port    → eligible (same_port)
  TLS_000           — ARN name, TLS SNI match, host=0.0.0.0, same port      → eligible (same_port)
  TLS_LOCALHOST     — ARN name, TLS SNI match, host=localhost, same port    → eligible (same_port)
  TLS_REMOTE        — ARN name, TLS SNI match, host=some.proxy.com          → NOT a server match
  TLS_WRONG_SNI     — ARN name, TLS wrong SNI, host=127.0.0.1               → NOT a server match
  TLS_127_DIFF_PORT — ARN name, TLS SNI match, host=127.0.0.1, port 8080    → skipped (diff non-443)
  CUSTOM            — Custom name, direct host match                        → server matches, protected
  ALIAS             — Name == cluster_alias, direct host match              → eligible (same_name, top priority)
  ALIAS_TLS         — Name == cluster_alias, TLS SNI match, host=127.0.0.1  → eligible (same_name, top priority)
  UNRELATED         — Completely different server                           → no match at all
  BAD_PORT          — ARN name, non-digit port                              → skipped entirely
"""

import os
import tempfile
from copy import deepcopy

import pytest
import yaml

from src.v2.kube import update_kube_cluster_config

LOCAL_SERVER = "my.endpoint.com"
LOCAL_PORT = 9443
ALIAS = "my-tunnel-alias"


# ===== Entry archetype factories =====

def _arn(suffix="my-cluster"):
    return f"arn:aws:eks:us-east-1:123456:cluster/{suffix}"


ARCHETYPES = {
    "ARN_SAME_PORT": {
        "name": _arn(),
        "cluster": {"server": f"https://{LOCAL_SERVER}:{LOCAL_PORT}"},
    },
    "ARN_NO_PORT": {
        "name": _arn(),
        "cluster": {"server": f"https://{LOCAL_SERVER}"},
    },
    "ARN_PORT_443": {
        "name": _arn(),
        "cluster": {"server": f"https://{LOCAL_SERVER}:443"},
    },
    "ARN_DIFF_PORT": {
        "name": _arn(),
        "cluster": {"server": f"https://{LOCAL_SERVER}:8080"},
    },
    "TLS_127": {
        "name": _arn(),
        "cluster": {
            "server": f"https://127.0.0.1:{LOCAL_PORT}",
            "tls-server-name": LOCAL_SERVER,
        },
    },
    "TLS_000": {
        "name": _arn(),
        "cluster": {
            "server": f"https://0.0.0.0:{LOCAL_PORT}",
            "tls-server-name": LOCAL_SERVER,
        },
    },
    "TLS_LOCALHOST": {
        "name": _arn(),
        "cluster": {
            "server": f"https://localhost:{LOCAL_PORT}",
            "tls-server-name": LOCAL_SERVER,
        },
    },
    "TLS_REMOTE": {
        "name": _arn(),
        "cluster": {
            "server": f"https://some.proxy.com:{LOCAL_PORT}",
            "tls-server-name": LOCAL_SERVER,
        },
    },
    "TLS_WRONG_SNI": {
        "name": _arn(),
        "cluster": {
            "server": f"https://127.0.0.1:{LOCAL_PORT}",
            "tls-server-name": "other.endpoint.com",
        },
    },
    "TLS_127_DIFF_PORT": {
        "name": _arn(),
        "cluster": {
            "server": "https://127.0.0.1:8080",
            "tls-server-name": LOCAL_SERVER,
        },
    },
    "CUSTOM": {
        "name": "my-custom-cluster",
        "cluster": {"server": f"https://{LOCAL_SERVER}:443"},
    },
    "ALIAS": {
        "name": ALIAS,
        "cluster": {"server": f"https://{LOCAL_SERVER}:7777"},
    },
    "ALIAS_TLS": {
        "name": ALIAS,
        "cluster": {
            "server": f"https://127.0.0.1:7777",
            "tls-server-name": LOCAL_SERVER,
        },
    },
    "UNRELATED": {
        "name": _arn("other-cluster"),
        "cluster": {"server": "https://other.host.com:443"},
    },
    "BAD_PORT": {
        "name": _arn(),
        "cluster": {"server": f"https://{LOCAL_SERVER}:abc"},
    },
}

# Which archetypes are eligible as candidates (server matches AND passes bucket rules)?
# When no alias is provided:
ELIGIBLE_NO_ALIAS = {"ARN_SAME_PORT", "ARN_NO_PORT", "TLS_127", "TLS_000", "TLS_LOCALHOST"}
# When alias=ALIAS is provided, ALIAS/ALIAS_TLS entries also become eligible:
ELIGIBLE_WITH_ALIAS = ELIGIBLE_NO_ALIAS | {"ALIAS", "ALIAS_TLS"}


# ===== Helpers =====

def _make_entry(archetype_key: str, unique_suffix: str | None = None):
    """Return a deep copy of an archetype, optionally making ARN name unique."""
    entry = deepcopy(ARCHETYPES[archetype_key])
    if unique_suffix and entry["name"].startswith("arn:aws:eks:"):
        entry["name"] = _arn(unique_suffix)
    return entry


def _write_kubeconfig(clusters, contexts=None) -> str:
    config = {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": clusters,
        "contexts": contexts or [],
        "users": [],
        "current-context": "",
    }
    fd, path = tempfile.mkstemp(suffix=".yaml", prefix="kubeconfig_test_")
    with os.fdopen(fd, "w") as f:
        yaml.safe_dump(config, f)
    return path


def _read_kubeconfig(path):
    with open(path, "r") as f:
        return yaml.safe_load(f)


def _run(clusters, local_port=LOCAL_PORT, cluster_alias=None, contexts=None):
    """Write config, run update, return (result, config_after, path)."""
    path = _write_kubeconfig(clusters, contexts)
    result = update_kube_cluster_config(path, LOCAL_SERVER, local_port, cluster_alias=cluster_alias)
    config = _read_kubeconfig(path)
    return result, config, path


def _assert_updated(cluster_entry, local_port=LOCAL_PORT):
    """Assert a cluster entry was rewritten to the tunnel."""
    assert cluster_entry["cluster"]["server"] == f"https://127.0.0.1:{local_port}"
    assert cluster_entry["cluster"]["tls-server-name"] == LOCAL_SERVER


def _assert_untouched(cluster_entry, original_entry):
    """Assert a cluster entry was NOT modified."""
    assert cluster_entry["cluster"]["server"] == original_entry["cluster"]["server"]


# ===================================================================
# SECTION 1: Single entry — each archetype alone
# ===================================================================
class TestSingleEntry:
    """Each archetype as the only entry in the kubeconfig."""

    def test_empty_clusters(self):
        result, _, path = _run([])
        os.unlink(path)
        assert result is False

    @pytest.mark.parametrize("key", sorted(ELIGIBLE_NO_ALIAS))
    def test_eligible_entry_no_alias(self, key):
        entry = _make_entry(key)
        result, config, path = _run([entry])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])

    @pytest.mark.parametrize("key", sorted({"ARN_PORT_443", "ARN_DIFF_PORT", "TLS_REMOTE",
                                             "TLS_WRONG_SNI", "TLS_127_DIFF_PORT", "CUSTOM",
                                             "UNRELATED", "BAD_PORT"}))
    def test_ineligible_entry_no_alias(self, key):
        entry = _make_entry(key)
        result, config, path = _run([entry])
        os.unlink(path)
        assert result is False
        _assert_untouched(config["clusters"][0], ARCHETYPES[key])

    def test_alias_entry_with_alias(self):
        entry = _make_entry("ALIAS")
        result, cfg, path = _run([entry], cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_updated(cfg["clusters"][0])

    def test_alias_tls_entry_with_alias(self):
        entry = _make_entry("ALIAS_TLS")
        result, config, path = _run([entry], cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])

    def test_alias_entry_without_alias_arg(self):
        """ALIAS entry exists but no alias arg passed → treated as custom name, protected."""
        entry = _make_entry("ALIAS")
        result, config, path = _run([entry])
        os.unlink(path)
        assert result is False

    def test_arn_port_443_with_local_port_443(self):
        """ARN at port 443 with local_port=443 → same_port match."""
        entry = _make_entry("ARN_PORT_443")
        result, config, path = _run([entry], local_port=443)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0], local_port=443)


# ===================================================================
# SECTION 2: Two entries — every meaningful pair
# ===================================================================
class TestTwoEntries:
    """Pairs of entries testing priority, protection, and isolation."""

    # --- Eligible + Unrelated → eligible updated, unrelated untouched ---

    @pytest.mark.parametrize("eligible_key", sorted(ELIGIBLE_NO_ALIAS))
    def test_eligible_plus_unrelated(self, eligible_key):
        e = _make_entry(eligible_key)
        u = _make_entry("UNRELATED")
        result, config, path = _run([e, u])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        _assert_untouched(config["clusters"][1], ARCHETYPES["UNRELATED"])

    def test_unrelated_plus_eligible(self):
        """Unrelated first, eligible second → eligible still selected."""
        u = _make_entry("UNRELATED")
        e = _make_entry("ARN_SAME_PORT")
        result, config, path = _run([u, e])
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["UNRELATED"])
        _assert_updated(config["clusters"][1])

    # --- Eligible + Protected custom → eligible updated, custom untouched ---

    @pytest.mark.parametrize("eligible_key", sorted(ELIGIBLE_NO_ALIAS))
    def test_eligible_plus_custom(self, eligible_key):
        e = _make_entry(eligible_key)
        c = _make_entry("CUSTOM")
        result, config, path = _run([e, c])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        _assert_untouched(config["clusters"][1], ARCHETYPES["CUSTOM"])

    # --- Two ineligible → False ---

    @pytest.mark.parametrize("a,b", [
        ("CUSTOM", "UNRELATED"),
        ("CUSTOM", "CUSTOM"),
        ("ARN_DIFF_PORT", "CUSTOM"),
        ("ARN_PORT_443", "ARN_DIFF_PORT"),
        ("TLS_REMOTE", "TLS_WRONG_SNI"),
        ("UNRELATED", "UNRELATED"),
        ("BAD_PORT", "CUSTOM"),
        ("TLS_127_DIFF_PORT", "ARN_DIFF_PORT"),
    ])
    def test_two_ineligible(self, a, b):
        ea = _make_entry(a, unique_suffix=f"{a}-1")
        eb = _make_entry(b, unique_suffix=f"{b}-2")
        result, _, path = _run([ea, eb])
        os.unlink(path)
        assert result is False

    # --- Two eligible of same type → first wins ---

    @pytest.mark.parametrize("key", ["ARN_SAME_PORT", "ARN_NO_PORT", "TLS_127"])
    def test_two_same_eligible_first_wins(self, key):
        e1 = _make_entry(key, unique_suffix="cluster-a")
        e2 = _make_entry(key, unique_suffix="cluster-b")
        result, config, path = _run([e1, e2])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        # Second entry untouched
        assert config["clusters"][1]["cluster"]["server"] == ARCHETYPES[key]["cluster"]["server"]

    # --- Alias match beats any eligible ---

    @pytest.mark.parametrize("other_key", sorted(ELIGIBLE_NO_ALIAS))
    def test_alias_beats_eligible(self, other_key):
        """Alias entry should be selected even when another eligible entry exists."""
        other = _make_entry(other_key)
        alias_entry = _make_entry("ALIAS")
        result, config, path = _run([other, alias_entry], cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        # The alias entry (index 1) should be updated
        _assert_updated(config["clusters"][1])
        # The other eligible entry should be untouched
        _assert_untouched(config["clusters"][0], ARCHETYPES[other_key])

    def test_alias_beats_eligible_reversed_order(self):
        """Alias first, eligible second → alias still wins (priority, not position)."""
        alias_entry = _make_entry("ALIAS")
        other = _make_entry("ARN_SAME_PORT")
        result, config, path = _run([alias_entry, other], cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        _assert_untouched(config["clusters"][1], ARCHETYPES["ARN_SAME_PORT"])

    # --- Alias + custom → alias updated, custom protected ---

    def test_alias_plus_custom(self):
        alias_entry = _make_entry("ALIAS")
        custom = _make_entry("CUSTOM")
        result, config, path = _run([custom, alias_entry], cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["CUSTOM"])
        _assert_updated(config["clusters"][1])

    # --- Alias + ineligible → alias updated ---

    @pytest.mark.parametrize("ineligible_key", ["ARN_DIFF_PORT", "TLS_REMOTE", "ARN_PORT_443"])
    def test_alias_plus_ineligible(self, ineligible_key):
        inelig = _make_entry(ineligible_key)
        alias_entry = _make_entry("ALIAS")
        result, config, path = _run([inelig, alias_entry], cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES[ineligible_key])
        _assert_updated(config["clusters"][1])

    # --- TLS variants vs direct hostname ---

    def test_tls_127_plus_direct_arn(self):
        """TLS entry (127.0.0.1) and direct ARN entry — both eligible, first wins."""
        tls = _make_entry("TLS_127", unique_suffix="tls-cluster")
        direct = _make_entry("ARN_SAME_PORT", unique_suffix="direct-cluster")
        result, config, path = _run([tls, direct])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        _assert_untouched(config["clusters"][1], ARCHETYPES["ARN_SAME_PORT"])

    def test_direct_arn_plus_tls_127(self):
        """Direct first, TLS second — direct wins by position."""
        direct = _make_entry("ARN_SAME_PORT", unique_suffix="direct-cluster")
        tls = _make_entry("TLS_127", unique_suffix="tls-cluster")
        result, config, path = _run([direct, tls])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])

    # --- Mixed TLS localhost variants ---

    def test_tls_127_plus_tls_000(self):
        """Both TLS with different localhost IPs — both eligible, first wins."""
        t1 = _make_entry("TLS_127", unique_suffix="tls-127")
        t2 = _make_entry("TLS_000", unique_suffix="tls-000")
        result, config, path = _run([t1, t2])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])

    # --- Eligible + BAD_PORT → bad_port skipped, eligible still found ---

    def test_bad_port_plus_eligible(self):
        bad = _make_entry("BAD_PORT", unique_suffix="bad")
        good = _make_entry("ARN_SAME_PORT", unique_suffix="good")
        result, config, path = _run([bad, good])
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][1])

    # --- ARN_PORT_443 + ARN_SAME_PORT → only same_port eligible ---

    def test_arn_443_plus_arn_same_port(self):
        p443 = _make_entry("ARN_PORT_443", unique_suffix="c443")
        same = _make_entry("ARN_SAME_PORT", unique_suffix="csame")
        result, config, path = _run([p443, same])
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["ARN_PORT_443"])
        _assert_updated(config["clusters"][1])

    # --- ARN_DIFF_PORT + ARN_SAME_PORT ---

    def test_arn_diff_port_plus_arn_same_port(self):
        diff = _make_entry("ARN_DIFF_PORT", unique_suffix="cdiff")
        same = _make_entry("ARN_SAME_PORT", unique_suffix="csame")
        result, config, path = _run([diff, same])
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["ARN_DIFF_PORT"])
        _assert_updated(config["clusters"][1])

    # --- TLS_REMOTE + eligible → remote doesn't match, eligible found ---

    def test_tls_remote_plus_eligible(self):
        remote = _make_entry("TLS_REMOTE")
        eligible = _make_entry("ARN_SAME_PORT", unique_suffix="good")
        result, config, path = _run([remote, eligible])
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["TLS_REMOTE"])
        _assert_updated(config["clusters"][1])

    # --- TLS_127_DIFF_PORT + TLS_127 → diff port skipped, same port found ---

    def test_tls_diff_port_plus_tls_same_port(self):
        diff = _make_entry("TLS_127_DIFF_PORT", unique_suffix="tdiff")
        same = _make_entry("TLS_127", unique_suffix="tsame")
        result, config, path = _run([diff, same])
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["TLS_127_DIFF_PORT"])
        _assert_updated(config["clusters"][1])


# ===================================================================
# SECTION 3: Three entries — mixed scenarios
# ===================================================================
class TestThreeEntries:
    """Three-entry combinations for realistic multi-app kubeconfigs."""

    def test_alias_arn_same_port_unrelated(self):
        """Alias + ARN_SAME_PORT + UNRELATED → alias wins."""
        entries = [
            _make_entry("ARN_SAME_PORT"),
            _make_entry("ALIAS"),
            _make_entry("UNRELATED"),
        ]
        result, config, path = _run(entries, cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["ARN_SAME_PORT"])
        _assert_updated(config["clusters"][1])
        _assert_untouched(config["clusters"][2], ARCHETYPES["UNRELATED"])

    def test_alias_tls_direct_custom(self):
        """ALIAS_TLS + direct ARN + CUSTOM → alias wins, others untouched."""
        entries = [
            _make_entry("ARN_SAME_PORT"),
            _make_entry("CUSTOM"),
            _make_entry("ALIAS_TLS"),
        ]
        result, config, path = _run(entries, cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["ARN_SAME_PORT"])
        _assert_untouched(config["clusters"][1], ARCHETYPES["CUSTOM"])
        _assert_updated(config["clusters"][2])

    def test_tls_direct_custom(self):
        """TLS_127 + direct ARN + CUSTOM (no alias) → TLS_127 first in same_port, wins."""
        entries = [
            _make_entry("TLS_127", unique_suffix="tls-c"),
            _make_entry("ARN_SAME_PORT", unique_suffix="direct-c"),
            _make_entry("CUSTOM"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        _assert_untouched(config["clusters"][1], ARCHETYPES["ARN_SAME_PORT"])
        _assert_untouched(config["clusters"][2], ARCHETYPES["CUSTOM"])

    def test_three_ineligible(self):
        """ARN_PORT_443 + ARN_DIFF_PORT + CUSTOM → all ineligible, False."""
        entries = [
            _make_entry("ARN_PORT_443"),
            _make_entry("ARN_DIFF_PORT"),
            _make_entry("CUSTOM"),
        ]
        result, _, path = _run(entries)
        os.unlink(path)
        assert result is False

    def test_ineligible_ineligible_eligible(self):
        """Two ineligible then one eligible → eligible found."""
        entries = [
            _make_entry("CUSTOM"),
            _make_entry("ARN_DIFF_PORT"),
            _make_entry("ARN_SAME_PORT"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["CUSTOM"])
        _assert_untouched(config["clusters"][1], ARCHETYPES["ARN_DIFF_PORT"])
        _assert_updated(config["clusters"][2])

    def test_bad_port_custom_eligible(self):
        """BAD_PORT + CUSTOM + eligible → bad skipped, custom protected, eligible found."""
        entries = [
            _make_entry("BAD_PORT"),
            _make_entry("CUSTOM"),
            _make_entry("TLS_000", unique_suffix="good"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][2])

    def test_three_eligible_first_wins(self):
        """Three eligible entries → first in list wins."""
        entries = [
            _make_entry("ARN_SAME_PORT", unique_suffix="c-a"),
            _make_entry("TLS_127", unique_suffix="c-b"),
            _make_entry("ARN_NO_PORT", unique_suffix="c-c"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        assert config["clusters"][1]["cluster"]["server"] == ARCHETYPES["TLS_127"]["cluster"]["server"]
        assert config["clusters"][2]["cluster"]["server"] == ARCHETYPES["ARN_NO_PORT"]["cluster"]["server"]

    def test_unrelated_unrelated_eligible(self):
        """Two unrelated + one eligible → eligible found at the end."""
        entries = [
            _make_entry("UNRELATED"),
            {"name": _arn("another-unrelated"), "cluster": {"server": "https://foo.bar.com:443"}},
            _make_entry("ARN_SAME_PORT"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][2])

    def test_tls_remote_tls_wrong_sni_tls_127(self):
        """TLS_REMOTE + TLS_WRONG_SNI + TLS_127 → only TLS_127 matches."""
        entries = [
            _make_entry("TLS_REMOTE", unique_suffix="remote"),
            _make_entry("TLS_WRONG_SNI", unique_suffix="wrong"),
            _make_entry("TLS_127", unique_suffix="good"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["TLS_REMOTE"])
        _assert_untouched(config["clusters"][1], ARCHETYPES["TLS_WRONG_SNI"])
        _assert_updated(config["clusters"][2])

    def test_alias_plus_two_tls_variants(self):
        """ALIAS + TLS_127 + TLS_000 → alias wins over both TLS."""
        entries = [
            _make_entry("TLS_127", unique_suffix="tls1"),
            _make_entry("ALIAS"),
            _make_entry("TLS_000", unique_suffix="tls2"),
        ]
        result, config, path = _run(entries, cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["TLS_127"])
        _assert_updated(config["clusters"][1])
        _assert_untouched(config["clusters"][2], ARCHETYPES["TLS_000"])


# ===================================================================
# SECTION 4: Four+ entries — realistic multi-tool kubeconfigs
# ===================================================================
class TestFourPlusEntries:
    """Realistic scenarios where multiple tools have written to the same kubeconfig."""

    def test_full_realistic_kubeconfig(self):
        """Simulates a real kubeconfig with entries from aws CLI, manual edits, and our tool."""
        entries = [
            # aws eks update-kubeconfig wrote this (ARN name, original endpoint)
            _make_entry("ARN_PORT_443"),
            # Someone manually added a custom-named entry
            _make_entry("CUSTOM"),
            # Our tool previously wrote this (TLS SNI on 127.0.0.1)
            _make_entry("TLS_127", unique_suffix="prev-tunnel"),
            # Completely unrelated cluster
            _make_entry("UNRELATED"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        # ARN_PORT_443 falls through (443 != 9443)
        _assert_untouched(config["clusters"][0], ARCHETYPES["ARN_PORT_443"])
        # CUSTOM protected
        _assert_untouched(config["clusters"][1], ARCHETYPES["CUSTOM"])
        # TLS_127 is the only eligible entry
        _assert_updated(config["clusters"][2])
        # UNRELATED untouched
        _assert_untouched(config["clusters"][3], ARCHETYPES["UNRELATED"])

    def test_four_with_alias_targeting_custom(self):
        """Alias targets a custom-named entry among ARNs and unrelated entries."""
        entries = [
            _make_entry("UNRELATED"),
            _make_entry("ARN_SAME_PORT"),
            _make_entry("ALIAS"),  # custom name = ALIAS, server matches
            _make_entry("ARN_DIFF_PORT"),
        ]
        result, config, path = _run(entries, cluster_alias=ALIAS)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["UNRELATED"])
        _assert_untouched(config["clusters"][1], ARCHETYPES["ARN_SAME_PORT"])
        _assert_updated(config["clusters"][2])  # alias wins
        _assert_untouched(config["clusters"][3], ARCHETYPES["ARN_DIFF_PORT"])

    def test_all_three_localhost_tls_variants(self):
        """TLS on 127.0.0.1, 0.0.0.0, and localhost — all eligible, first wins."""
        entries = [
            _make_entry("TLS_LOCALHOST", unique_suffix="lh"),
            _make_entry("TLS_127", unique_suffix="127"),
            _make_entry("TLS_000", unique_suffix="000"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][0])
        assert config["clusters"][1]["cluster"]["server"] == ARCHETYPES["TLS_127"]["cluster"]["server"]
        assert config["clusters"][2]["cluster"]["server"] == ARCHETYPES["TLS_000"]["cluster"]["server"]

    def test_five_entries_mixed_everything(self):
        """BAD_PORT + TLS_REMOTE + CUSTOM + ARN_DIFF_PORT + ARN_SAME_PORT."""
        entries = [
            _make_entry("BAD_PORT", unique_suffix="bad"),
            _make_entry("TLS_REMOTE", unique_suffix="remote"),
            _make_entry("CUSTOM"),
            _make_entry("ARN_DIFF_PORT", unique_suffix="diff"),
            _make_entry("ARN_SAME_PORT", unique_suffix="match"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        # Only the last entry (ARN_SAME_PORT) is eligible
        for i in range(4):
            assert "tls-server-name" not in config["clusters"][i]["cluster"] or \
                   config["clusters"][i]["cluster"].get("tls-server-name") != LOCAL_SERVER or \
                   config["clusters"][i]["cluster"]["server"] != f"https://127.0.0.1:{LOCAL_PORT}"
        _assert_updated(config["clusters"][4])

    def test_all_ineligible_types(self):
        """Every ineligible archetype together → False."""
        entries = [
            _make_entry("ARN_PORT_443"),
            _make_entry("ARN_DIFF_PORT"),
            _make_entry("TLS_REMOTE"),
            _make_entry("TLS_WRONG_SNI"),
            _make_entry("TLS_127_DIFF_PORT"),
            _make_entry("CUSTOM"),
            _make_entry("UNRELATED"),
            _make_entry("BAD_PORT"),
        ]
        result, _, path = _run(entries)
        os.unlink(path)
        assert result is False


# ===================================================================
# SECTION 5: Context renaming in multi-entry configs
# ===================================================================
class TestContextRenamingMulti:
    """Context renaming with multiple clusters and contexts."""

    def test_alias_renames_matching_context_only(self):
        """When alias matches, only the context with the same name gets its cluster ref updated."""
        entries = [
            _make_entry("UNRELATED"),
            _make_entry("ALIAS"),
        ]
        contexts = [
            {"name": "other-context", "context": {"cluster": "other-ref", "user": "u1"}},
            {"name": ALIAS, "context": {"cluster": "old-ref", "user": "u2"}},
            {"name": "third-context", "context": {"cluster": "third-ref", "user": "u3"}},
        ]
        result, config, path = _run(entries, cluster_alias=ALIAS, contexts=contexts)
        os.unlink(path)
        assert result is True
        # Only the ALIAS context gets updated
        assert config["contexts"][0]["context"]["cluster"] == "other-ref"
        assert config["contexts"][1]["context"]["cluster"] == ALIAS
        assert config["contexts"][2]["context"]["cluster"] == "third-ref"

    def test_no_context_renamed_without_alias(self):
        """Without alias, no contexts are modified even if entry is updated."""
        entries = [_make_entry("ARN_SAME_PORT")]
        contexts = [
            {"name": "ctx1", "context": {"cluster": "old-ref", "user": "u"}},
        ]
        result, config, path = _run(entries, contexts=contexts)
        os.unlink(path)
        assert result is True
        assert config["contexts"][0]["context"]["cluster"] == "old-ref"

    def test_multiple_clusters_and_contexts_with_alias(self):
        """Realistic: 3 clusters, 3 contexts, alias targets one."""
        entries = [
            _make_entry("UNRELATED"),
            _make_entry("ARN_SAME_PORT"),
            _make_entry("ALIAS"),
        ]
        contexts = [
            {"name": "unrelated-ctx", "context": {"cluster": "unrelated-c", "user": "u1"}},
            {"name": "arn-ctx", "context": {"cluster": _arn(), "user": "u2"}},
            {"name": ALIAS, "context": {"cluster": "stale-ref", "user": "u3"}},
        ]
        result, config, path = _run(entries, cluster_alias=ALIAS, contexts=contexts)
        os.unlink(path)
        assert result is True
        # Alias entry updated
        _assert_updated(config["clusters"][2])
        # Only ALIAS context's cluster ref updated
        assert config["contexts"][0]["context"]["cluster"] == "unrelated-c"
        assert config["contexts"][1]["context"]["cluster"] == _arn()
        assert config["contexts"][2]["context"]["cluster"] == ALIAS


# ===================================================================
# SECTION 6: Case insensitivity across entry types
# ===================================================================
class TestCaseInsensitivityCombinations:
    """Case insensitivity with multiple entries."""

    def test_mixed_case_direct_host_among_others(self):
        """UPPER-CASE host entry among unrelated entries."""
        entries = [
            _make_entry("UNRELATED"),
            {
                "name": _arn("upper"),
                "cluster": {"server": f"https://MY.ENDPOINT.COM:{LOCAL_PORT}"},
            },
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_updated(config["clusters"][1])

    def test_mixed_case_tls_among_others(self):
        """TLS SNI with mixed case among other entries."""
        entries = [
            _make_entry("CUSTOM"),
            {
                "name": _arn("tls-upper"),
                "cluster": {
                    "server": f"https://127.0.0.1:{LOCAL_PORT}",
                    "tls-server-name": "MY.ENDPOINT.COM",
                },
            },
            _make_entry("UNRELATED"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["CUSTOM"])
        _assert_updated(config["clusters"][1])
        _assert_untouched(config["clusters"][2], ARCHETYPES["UNRELATED"])


# ===================================================================
# SECTION 7: No-protocol server URLs in multi-entry
# ===================================================================
class TestNoProtocolMulti:
    """Server URLs without :// among normal entries."""

    def test_no_protocol_among_https_entries(self):
        entries = [
            _make_entry("UNRELATED"),
            {
                "name": _arn("noproto"),
                "cluster": {"server": f"{LOCAL_SERVER}:{LOCAL_PORT}"},
            },
            _make_entry("CUSTOM"),
        ]
        result, config, path = _run(entries)
        os.unlink(path)
        assert result is True
        _assert_untouched(config["clusters"][0], ARCHETYPES["UNRELATED"])
        _assert_updated(config["clusters"][1])
        _assert_untouched(config["clusters"][2], ARCHETYPES["CUSTOM"])
