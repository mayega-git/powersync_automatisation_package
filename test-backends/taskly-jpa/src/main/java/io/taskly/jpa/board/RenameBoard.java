package io.taskly.jpa.board;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record RenameBoard(@NotBlank @Size(max = 60) String name) {}
