package io.taskly.api.label;

import java.util.UUID;
import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/** Shared vocabulary, identical for every workspace. */
@Table(name = "label")
public record Label(@Id UUID id, String code, String title, int rank) {}
