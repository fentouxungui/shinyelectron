test_that("local_r_package_names resolves directories and archives", {
  dir <- file.path(tempfile("pkg-"), "MyPkg")
  dir.create(file.path(dir, "R"), recursive = TRUE)
  writeLines(c("Package: MyPkg", "Version: 0.1.0", "Title: t", "Description: t.",
               "License: MIT", "Encoding: UTF-8"), file.path(dir, "DESCRIPTION"))
  writeLines("", file.path(dir, "NAMESPACE"))

  expect_equal(local_r_package_names(dir), "MyPkg")
  expect_equal(
    local_r_package_names(c(dir, "SeuratExplorer_0.1.9.tar.gz")),
    c("MyPkg", "SeuratExplorer")
  )
  expect_equal(local_r_package_names(character(0)), character(0))
  expect_equal(local_r_package_names(list()), character(0))
})

test_that("local_r_package_deps reads declared deps and drops base packages", {
  dir <- file.path(tempfile("pkg-"), "MyPkg")
  dir.create(file.path(dir, "R"), recursive = TRUE)
  writeLines(c(
    "Package: MyPkg", "Version: 0.1.0", "Title: t", "Description: t.",
    "License: MIT", "Encoding: UTF-8",
    "Depends: R (>= 4.1.0), shiny",
    "Imports: stats, Seurat (>= 5.0.0), Rcpp",
    "LinkingTo: RcppArmadillo",
    "Suggests: testthat"
  ), file.path(dir, "DESCRIPTION"))
  writeLines("", file.path(dir, "NAMESPACE"))

  deps <- local_r_package_deps(dir)
  expect_true(all(c("shiny", "Seurat", "Rcpp", "RcppArmadillo") %in% deps))
  expect_false("R" %in% deps)
  expect_false("stats" %in% deps)
  expect_false("testthat" %in% deps)

  expect_equal(local_r_package_deps(character(0)), character(0))
})

test_that("install_local_r_packages installs a source directory into the target library", {
  skip_on_cran()

  work <- tempfile("lpkg-")
  dir.create(work)
  lib <- file.path(work, "lib")
  dir.create(lib)

  pkg <- file.path(work, "hello")
  dir.create(file.path(pkg, "R"), recursive = TRUE)
  writeLines(c("Package: hello", "Version: 0.0.1", "Title: t", "Description: t.",
               "License: MIT", "Encoding: UTF-8"), file.path(pkg, "DESCRIPTION"))
  writeLines("export(greet)", file.path(pkg, "NAMESPACE"))
  writeLines("greet <- function() 'hi'", file.path(pkg, "R", "g.R"))

  install_local_r_packages(pkg, lib, verbose = FALSE)

  expect_true(file.exists(file.path(lib, "hello", "DESCRIPTION")))
  expect_true(file.exists(file.path(lib, "hello", "NAMESPACE")))
})