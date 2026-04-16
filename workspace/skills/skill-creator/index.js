module.exports = {
  init_skill: async (args) => {
    const { skill_name, output_directory, resources, examples } = args;

    if (!skill_name || !output_directory) {
      return { error: 'Skill name and output directory are required.' };
    }

    const fs = require('fs');
    const path = require('path');

    const skillDirectory = path.join(output_directory, skill_name);

    try {
      fs.mkdirSync(skillDirectory, { recursive: true });

      const skillMdContent = `---
name: ${skill_name}
description: TODO: Add a comprehensive description of the skill and its triggers.
---

# ${skill_name}

TODO: Add instructions for using the skill.
`;
      fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), skillMdContent);

      if (resources) {
        const resourceList = resources.split(',');
        resourceList.forEach((resource) => {
          const resourceDirectory = path.join(skillDirectory, resource.trim());
          fs.mkdirSync(resourceDirectory, { recursive: true });
          if (examples) {
            fs.writeFileSync(path.join(resourceDirectory, 'example.txt'), `Example file for ${resource}`);
          }
        });
      }

      return { result: `Skill directory '${skill_name}' created successfully at ${skillDirectory}` };
    } catch (error) {
      return { error: `Failed to create skill directory: ${error.message}` };
    }
  },
  package_skill: async (args) => {
    const { skill_folder, output_directory = '.' } = args;

    if (!skill_folder) {
      return { error: 'Skill folder is required.' };
    }

    const fs = require('fs');
    const path = require('path');
    const archiver = require('archiver');

    const skillName = path.basename(skill_folder);
    const outputFile = path.join(output_directory, `${skillName}.skill`);

    try {
      // Validation (simplified for example)
      const skillMdPath = path.join(skill_folder, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) {
        return { error: 'SKILL.md file not found.' };
      }

      const yaml = require('js-yaml');
      const skillMdContent = fs.readFileSync(skillMdPath, 'utf8');
      const yamlBlock = skillMdContent.split('---')[1];
      const frontmatter = yaml.load(yamlBlock);

      if (!frontmatter || !frontmatter.name || !frontmatter.description) {
        return {error: 'SKILL.md must contain valid YAML frontmatter with name and description fields.'};
      }

      // Check for symlinks
      function checkForSymlinks(dir) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = fs.lstatSync(filePath);
          if (stats.isSymbolicLink()) {
            return true;
          }
          if (stats.isDirectory()) {
            if (checkForSymlinks(filePath)) {
              return true;
            }
          }
        }
        return false;
      }

      if (checkForSymlinks(skill_folder)) {
        return { error: 'Symlinks are not allowed in skills.' };
      }


      // Create .skill zip file
      const output = fs.createWriteStream(outputFile);
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('error', (err) => {
        throw err;
      });

      archive.pipe(output);
      archive.directory(skill_folder, false);
      await archive.finalize();

      return { result: `Skill '${skillName}' packaged successfully at ${outputFile}` };
    } catch (error) {
      return { error: `Failed to package skill: ${error.message}` };
    }
  },

  validate_skill_name: async (args) => {
      const { skill_name } = args;

      if (!skill_name) {
          return {error: 'Skill name is required.'};
      }

      if (skill_name.length > 64) {
          return {error: 'Skill name must be less than 64 characters.'};
      }

      const regex = /^[a-z0-9-]+$/;

      if (!regex.test(skill_name)) {
          return {error: 'Skill name must contain only lowercase letters, digits, and hyphens.'};
      }

      return {result: 'Skill name is valid.'};
  }
};
