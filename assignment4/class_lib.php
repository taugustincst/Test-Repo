<?php 

	class Animal {
		var $name;
		var $health;

		function __construct($animal_name) {
			$this->health = 100;
			$this->name = $animal_name;
		} 

		public function walk() {
			$this->health = $this->health - 1;
		}

		public function run() {
			$this->health = $this->health - 5;
		}
	
		public function displayHealth() {
			echo $this->health = $this->health . "<br />";
		}
	}

	class Dog extends Animal {

		function __construct($animal_name) {
			$this->health = 150;
			$this->name = $animal_name;
		}

		function pet() {
			$this->health = $this->health + 5;
		}

	}

	class Dragon extends Animal {
		
		function __construct($animal_name) {
			$this->health = 170;
			$this->name = $animal_name;
		}

		function displayHealth() {
			echo "this is a dragon <br />";
			parent::displayHealth();
		}

		function fly() {
			$this->health = $this->health - 10;
		}
	}


?>