package io.aeris.annotations;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Caps the offline class the compiler may give this endpoint. It can only make
 * the endpoint more restrictive than the analysis (or turn REPLAYABLE into
 * LOCAL_WRITE_SAFE): it never grants offline execution the compiler did not prove.
 */
@Documented
@Retention(RetentionPolicy.SOURCE)
@Target(ElementType.METHOD)
public @interface AerisOffline {
    AerisPolicy policy();
}
