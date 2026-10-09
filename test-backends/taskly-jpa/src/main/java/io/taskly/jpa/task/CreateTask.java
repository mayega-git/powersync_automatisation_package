package io.taskly.jpa.task;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateTask(@NotBlank @Size(max = 200) String title, Integer position) {}
