package io.aeris.annotations;

/** Offline classes of the AERIS architecture (section 12). */
public enum AerisPolicy {
    LOCAL_READ_SAFE,
    LOCAL_WRITE_SAFE,
    REPLAYABLE,
    SPECULATIVE,
    ONLINE_REQUIRED
}
