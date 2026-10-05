package io.aeris.annotations;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** This endpoint (or every endpoint of this controller) must never run offline. */
@Documented
@Retention(RetentionPolicy.SOURCE)
@Target({ElementType.METHOD, ElementType.TYPE})
public @interface AerisOnlineOnly {
    /** Why, shown in the AERIS report. */
    String value() default "";
}
